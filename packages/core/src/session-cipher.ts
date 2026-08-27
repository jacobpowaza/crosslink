/**
 * Bidirectional AEAD framing for an established session.
 *
 * Two traffic keys are derived at handshake: kC protects client→host frames,
 * kH protects host→client frames. Every frame is sealed with XChaCha20-Poly1305
 * under a fresh random 24-byte nonce; the additional authenticated data binds
 * the sending direction and a strictly-monotonic counter, so replay,
 * reordering, reflection and cross-direction substitution all fail
 * authentication and tear the session down.
 */
import {
  CrosslinkError,
  EncryptedFrame,
  ErrorCodes,
  base64ToBytes,
  bytesToBase64,
  decodeMessage,
  encodeMessage,
  utf8ToBytes,
  type CrosslinkMessage,
} from "@crosslink/protocol";
import { aeadOpen, aeadSeal, randomBytes } from "./crypto/primitives.js";

export type Role = "client" | "host";

export interface TrafficKeys {
  /** protects frames sent by the client */
  c2h: Uint8Array;
  /** protects frames sent by the host */
  h2c: Uint8Array;
}

const LABEL: Record<Role, "c2h" | "h2c"> = { client: "c2h", host: "h2c" };
const PEER_LABEL: Record<Role, "c2h" | "h2c"> = { client: "h2c", host: "c2h" };

export class SessionCipher {
  private sendCounter = 0;
  private recvExpected = 1;

  constructor(
    private readonly keys: TrafficKeys,
    private readonly role: Role,
    private readonly maxFrameBytes: number
  ) {}

  get role_(): Role {
    return this.role;
  }

  seal(msg: object): EncryptedFrame {
    this.sendCounter += 1;
    const n = this.sendCounter;
    const iv = randomBytes(24);
    const aad = utf8ToBytes(`${LABEL[this.role]}:${n}`);
    const plaintext = encodeMessage(msg);
    if (plaintext.length > this.maxFrameBytes) {
      throw new CrosslinkError(
        ErrorCodes.PAYLOAD_TOO_LARGE,
        `message ${plaintext.length}B exceeds session limit ${this.maxFrameBytes}B`
      );
    }
    const key = this.keys[LABEL[this.role]];
    const ct = aeadSeal(key, iv, plaintext, aad);
    return { kind: "enc", n, iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
  }

  open(frame: EncryptedFrame): CrosslinkMessage {
    if (
      typeof frame.n !== "number" ||
      !Number.isInteger(frame.n) ||
      frame.n !== this.recvExpected
    ) {
      throw new CrosslinkError(
        ErrorCodes.INVALID_MESSAGE,
        `replay/out-of-order frame: expected n=${this.recvExpected}, got ${String(frame.n)}`
      );
    }
    const n = frame.n;
    this.recvExpected += 1;
    const iv = base64ToBytes(frame.iv);
    if (iv.length !== 24) {
      throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "bad nonce length");
    }
    const aad = utf8ToBytes(`${PEER_LABEL[this.role]}:${n}`);
    let plaintext: Uint8Array;
    try {
      plaintext = aeadOpen(this.keys[PEER_LABEL[this.role]], iv, base64ToBytes(frame.ct), aad);
    } catch {
      throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "frame failed authentication");
    }
    return decodeMessage(plaintext) as unknown as CrosslinkMessage;
  }
}
