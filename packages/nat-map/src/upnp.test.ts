import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { upnpAddPortMapping, upnpDeletePortMapping, upnpExternalAddress, type UpnpGateway } from "./upnp.js";

interface RequestCapture {
  soapAction: string | null;
  body: string;
}

/** Starts an HTTP server whose SOAP responses are driven by `handler`. */
async function startSoapServer(
  handler: (req: RequestCapture, res: http.ServerResponse) => void
): Promise<{ server: http.Server; gateway: UpnpGateway; captured: () => RequestCapture[] }> {
  const captured: RequestCapture[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const capture: RequestCapture = {
        soapAction: req.headers.soapaction ? String(req.headers.soapaction) : null,
        body: Buffer.concat(chunks).toString("utf8")
      };
      captured.push(capture);
      handler(capture, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const gateway: UpnpGateway = {
    controlUrl: `http://127.0.0.1:${port}/ctl`,
    serviceType: "urn:schemas-upnp-org:service:WANIPConnection:1"
  };
  return { server, gateway, captured: () => captured };
}

describe("upnp", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("upnpExternalAddress parses NewExternalIPAddress from a successful SOAP response", async () => {
    const { server, gateway, captured } = await startSoapServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<s:Body><u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">` +
          `<NewExternalIPAddress>203.0.113.9</NewExternalIPAddress>` +
          `</u:GetExternalIPAddressResponse></s:Body></s:Envelope>`
      );
    });
    servers.push(server);

    const address = await upnpExternalAddress(gateway, 1500);
    expect(address).toBe("203.0.113.9");
    expect(captured()[0].soapAction).toBe(
      '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"'
    );
  });

  it("upnpAddPortMapping posts the mapping fields and resolves the requested mapping on success", async () => {
    const { server, gateway, captured } = await startSoapServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<s:Body><u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>` +
          `</s:Body></s:Envelope>`
      );
    });
    servers.push(server);

    const mapping = await upnpAddPortMapping(
      gateway,
      {
        internalClient: "192.168.1.50",
        internalPort: 8080,
        externalPort: 8080,
        lifetimeSeconds: 3600,
        description: "Crosslink"
      },
      1500
    );

    expect(mapping).toEqual({
      externalPort: 8080,
      internalPort: 8080,
      lifetimeSeconds: 3600,
      permanent: false
    });
    const body = captured()[0].body;
    expect(body).toContain("<NewExternalPort>8080</NewExternalPort>");
    expect(body).toContain("<NewInternalPort>8080</NewInternalPort>");
    expect(body).toContain("<NewInternalClient>192.168.1.50</NewInternalClient>");
    expect(body).toContain("<NewLeaseDuration>3600</NewLeaseDuration>");
    expect(captured()[0].soapAction).toBe(
      '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"'
    );
  });

  it("upnpDeletePortMapping posts the external port and protocol", async () => {
    const { server, gateway, captured } = await startSoapServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<s:Body><u:DeletePortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>` +
          `</s:Body></s:Envelope>`
      );
    });
    servers.push(server);

    await upnpDeletePortMapping(gateway, 8080, 1500);
    const body = captured()[0].body;
    expect(body).toContain("<NewExternalPort>8080</NewExternalPort>");
    expect(body).toContain("<NewProtocol>TCP</NewProtocol>");
  });

  it("upnpAddPortMapping throws with the SOAP fault description and code on HTTP 500", async () => {
    const { server, gateway } = await startSoapServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/xml" });
      res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>` +
          `<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
          `<errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription>` +
          `</UPnPError></detail></s:Fault></s:Body></s:Envelope>`
      );
    });
    servers.push(server);

    await expect(
      upnpAddPortMapping(
        gateway,
        {
          internalClient: "192.168.1.50",
          internalPort: 8080,
          externalPort: 8080,
          lifetimeSeconds: 3600,
          description: "Crosslink"
        },
        1500
      )
    ).rejects.toThrow(/ConflictInMappingEntry/);

    await expect(
      upnpAddPortMapping(
        gateway,
        {
          internalClient: "192.168.1.50",
          internalPort: 8080,
          externalPort: 8080,
          lifetimeSeconds: 3600,
          description: "Crosslink"
        },
        1500
      )
    ).rejects.toThrow(/718/);
  });

  it("retries with a permanent lease when the router only supports permanent ones", async () => {
    // Real hardware: many consumer routers reject any NewLeaseDuration > 0 with
    // fault 725. Honouring that is the difference between remote access working
    // and the whole feature silently not existing.
    let calls = 0;
    const { server, gateway, captured } = await startSoapServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(500, { "content-type": "text/xml" });
        res.end(
          `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
            `<s:Body><s:Fault><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
            `<errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription>` +
            `</UPnPError></detail></s:Fault></s:Body></s:Envelope>`
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<s:Body><u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>` +
          `</s:Body></s:Envelope>`
      );
    });
    servers.push(server);

    const mapping = await upnpAddPortMapping(
      gateway,
      {
        internalClient: "192.168.1.50",
        internalPort: 8100,
        externalPort: 8100,
        lifetimeSeconds: 7200,
        description: "Crosslink"
      },
      1500
    );

    expect(calls).toBe(2);
    expect(mapping.externalPort).toBe(8100);
    expect(mapping.permanent).toBe(true);
    // The mapping needs no renewal, but the reported lease stays the requested
    // one so the caller's renew timer keeps a consistent shape.
    expect(mapping.lifetimeSeconds).toBe(7200);
    // The first attempt asked for a lease; the retry asked for none.
    expect(captured()[0].body).toContain("<NewLeaseDuration>7200</NewLeaseDuration>");
    expect(captured()[1].body).toContain("<NewLeaseDuration>0</NewLeaseDuration>");
  });

  it("does not retry a fault that is not 725", async () => {
    let calls = 0;
    const { server, gateway } = await startSoapServer((_req, res) => {
      calls += 1;
      res.writeHead(500, { "content-type": "text/xml" });
      res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<s:Body><s:Fault><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
          `<errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription>` +
          `</UPnPError></detail></s:Fault></s:Body></s:Envelope>`
      );
    });
    servers.push(server);

    await expect(
      upnpAddPortMapping(
        gateway,
        {
          internalClient: "192.168.1.50",
          internalPort: 8100,
          externalPort: 8100,
          lifetimeSeconds: 7200,
          description: "Crosslink"
        },
        1500
      )
    ).rejects.toThrow(/718/);
    expect(calls).toBe(1);
  });
});
