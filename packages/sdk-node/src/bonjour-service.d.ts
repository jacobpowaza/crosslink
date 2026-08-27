declare module "bonjour-service" {
  export class Bonjour {
    publish(options: {
      name: string;
      type: string;
      port: number;
      txt: Record<string, string>;
    }): { stop(): void };
    find(
      options: { type: string },
      callback: (service: {
        name?: string;
        type: string;
        port: number;
        addresses?: string[];
        referer?: { address: string };
        txt?: Record<string, string>;
      }) => void
    ): { stop(): void };
    unpublishAll(): void;
    destroy(): void;
  }
}
