import { randomUUID } from "node:crypto";

import { type Capability, type Manifest } from "./manifest.js";
import { ParmanaClient } from "./parmana-client.js";

/**
 * The authority and authorization this deployment acts under. Set once in
 * configuration: agents do not choose them.
 */
export interface ToolContext {
  readonly parmana: ParmanaClient;
  readonly authority: {
    readonly authorityId: string;
    readonly authorityType: "USER" | "ROLE" | "SERVICE" | "ORGANIZATION";
    readonly principalId: string;
  };
  readonly authorizationId: string;
  readonly purpose: string;
  readonly sourceSystem: string;
  readonly submittedBy: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

/** One tool per capability in the manifest. The input schema is the capability's own. */
export function toolsFor(manifest: Manifest): ToolDefinition[] {
  return manifest.capabilities.map((cap) => ({
    name: cap.id,
    description: `${cap.method} ${cap.path} on ${manifest.system}. ${cap.effect === "write" ? "Changes data." : "Reads data."}`,
    inputSchema: inputSchemaFor(cap),
  }));
}

function inputSchemaFor(cap: Capability): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    target: { type: "string", minLength: 1, description: "What the action applies to, for example crm/deals/123." },
    signals: {
      type: "object",
      description: "Facts and signed approvals the policy requires, passed through unchanged. Get them from the person who approves the action.",
    },
  };
  const required = ["target"];
  for (const [name, field] of Object.entries(cap.input ?? {})) {
    properties[name] = { type: jsonType(field.type) };
    if (field.required === true) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function jsonType(type: string): string {
  return type === "integer" ? "integer" : type;
}

/**
 * Runs a tool call: reads the policy in effect for the capability, sends one
 * transaction to Parmana, and reports the outcome in words an agent can act on.
 */
export async function callTool(
  manifest: Manifest,
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const cap = manifest.capabilities.find((c) => c.id === name);
  if (cap === undefined) return failure(`Unknown tool "${name}".`);

  const { target, parameters, signals, problem } = splitArguments(cap, args);
  if (problem !== undefined) return failure(problem);

  const now = (ctx.now ?? (() => new Date()))();
  const newId = ctx.newId ?? randomUUID;
  const businessTransactionId = newId();

  const policy = await ctx.parmana.policyInEffect(cap.id);
  const body = {
    businessTransactionId,
    metadata: {
      businessTransactionId,
      correlationId: newId(),
      sourceSystem: ctx.sourceSystem,
      submittedBy: ctx.submittedBy,
      submittedAt: now.toISOString(),
    },
    authority: {
      authorityId: ctx.authority.authorityId,
      authorityType: ctx.authority.authorityType,
      principalId: ctx.authority.principalId,
      issuedAt: now.toISOString(),
    },
    authorization: {
      authorizationId: ctx.authorizationId,
      authorityId: ctx.authority.authorityId,
      purpose: ctx.purpose,
      issuedAt: now.toISOString(),
    },
    intent: {
      intentId: newId(),
      authorizationId: ctx.authorizationId,
      action: cap.id,
      target,
      parameters,
      createdAt: now.toISOString(),
    },
    policy: policy.policy,
    signals,
  };

  const response = await ctx.parmana.execute(body);
  return outcome(response.status, response.body, businessTransactionId);
}

function splitArguments(
  cap: Capability,
  args: Record<string, unknown>,
): { target: string; parameters: Record<string, unknown>; signals: Record<string, unknown>; problem?: string } {
  const { target, signals: rawSignals, ...rest } = args;
  if (typeof target !== "string" || target.trim() === "") {
    return { target: "", parameters: {}, signals: {}, problem: "target is required and must be a non-empty string." };
  }
  if (rawSignals !== undefined && (typeof rawSignals !== "object" || rawSignals === null || Array.isArray(rawSignals))) {
    return { target, parameters: {}, signals: {}, problem: "signals must be an object." };
  }
  const signals = (rawSignals ?? {}) as Record<string, unknown>;
  const declared = cap.input ?? {};
  for (const key of Object.keys(rest)) {
    if (!Object.prototype.hasOwnProperty.call(declared, key)) {
      return { target, parameters: {}, signals: {}, problem: `"${key}" is not an input of ${cap.id}.` };
    }
  }
  for (const [key, field] of Object.entries(declared)) {
    if (field.required === true && rest[key] === undefined) {
      return { target, parameters: {}, signals: {}, problem: `"${key}" is required.` };
    }
  }
  return { target, parameters: rest, signals };
}

function outcome(status: number, body: unknown, id: string): ToolResult {
  const code = errorCode(body);
  if (status === 200) {
    return success(JSON.stringify(body));
  }
  if (status === 403 && code === "POLICY_DENIED") {
    return failure(`Refused by policy. Nothing was released. Business transaction ${id}.`);
  }
  if (status === 403) {
    return failure("This key may not invoke this action. Nothing was released.");
  }
  if (status === 409 && code === "AUTHORIZATION_NO_LONGER_VALID") {
    return failure("A condition the decision rested on has expired. Nothing was sent. You may send a new request.");
  }
  if (status === 503) {
    return failure("Refused before release. Nothing was executed.");
  }
  if (status === 502 && code === "EXECUTION_OUTCOME_UNKNOWN") {
    return failure(
      `Released, but the outcome is unknown. Do not send this again under a new id. Check the target system for ${id}, then ask an operator to resolve the intent.`,
    );
  }
  if (status === 500 && code === "EXECUTION_RECORD_INCOMPLETE") {
    return failure(
      `Released, but the signed record could not be produced. Do not resend. An operator must finalize business transaction ${id}.`,
    );
  }
  return failure(`Parmana returned HTTP ${status}. Nothing was retried.`);
}

function errorCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "code" in body && typeof (body as { code: unknown }).code === "string") {
    return (body as { code: string }).code;
  }
  return undefined;
}

function success(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
