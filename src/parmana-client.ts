/**
 * The part of Parmana's HTTP API that an agent's tool calls use. It is a thin
 * wrapper: it sends what it is given and returns the status and the body.
 */
export interface ParmanaClientOptions {
  readonly baseUrl: string;
  /** The key for the caller, sent as "Authorization: Bearer <key>". Never logged. */
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  /** Parmana's documentation asks for 120 seconds, because an external call can take 30. */
  readonly timeoutMs?: number;
}

export interface InEffectPolicy {
  readonly capability: string;
  readonly policy: { readonly name: string; readonly version: string; readonly schemaVersion: string };
  readonly description: string | null;
}

export interface ParmanaResponse {
  readonly status: number;
  readonly body: unknown;
}

export class ParmanaClient {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ParmanaClientOptions) {
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** The policy and version to declare for a capability, read right before each call. */
  async policyInEffect(capability: string): Promise<InEffectPolicy> {
    const url = new URL("/policies/in-effect", this.options.baseUrl);
    url.searchParams.set("capability", capability);
    const response = await this.send(url.toString(), { method: "GET" });
    if (response.status !== 200) {
      throw new ParmanaUnavailableError(`policy lookup returned HTTP ${response.status}`);
    }
    return response.body as InEffectPolicy;
  }

  /** Sends one transaction. The businessTransactionId is the idempotency key. */
  async execute(body: unknown): Promise<ParmanaResponse> {
    return this.send(new URL("/execute", this.options.baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async send(url: string, init: RequestInit): Promise<ParmanaResponse> {
    let response: Response;
    try {
      response = await this.doFetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.options.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ParmanaUnavailableError("could not reach Parmana");
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      // Keep the raw text for a non-JSON reply.
    }
    return { status: response.status, body };
  }
}

export class ParmanaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParmanaUnavailableError";
  }
}
