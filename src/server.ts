import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { normalizeError, redactSecrets, generateSignature, extractSignals } from "./analyze";
import { findTopMatches } from "./match";
import type { IncidentRecord } from "./match";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });

    // Phase 1: Data Model Setup
    this.sql`
      CREATE TABLE IF NOT EXISTS incidents(
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        signature TEXT NOT NULL,
        error_type TEXT,
        title TEXT NOT NULL,
        symptoms TEXT,
        root_cause TEXT,
        fix_summary TEXT,
        runbook_id TEXT,
        severity TEXT,
        status TEXT,
        outcome TEXT,
        source TEXT,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        occurred_at INTEGER, 
        resolved_at INTEGER
      );
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS runbooks(
        id TEXT PRIMARY KEY,
        title TEXT, 
        error_type TEXT, 
        service_pattern TEXT,
        steps_json TEXT
      );
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS action_log(
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        incident_id TEXT,
        action_type TEXT,
        params_json TEXT,
        rationale TEXT,
        status TEXT,
        result TEXT,
        simulated INTEGER DEFAULT 1,
        executed_at INTEGER
      );
    `;

    // Phase 1: Seed data
    const countResult = this.sql`SELECT count(*) as count FROM incidents` as { count: number }[];
    if (countResult[0]?.count === 0) {
      console.log("Seeding initial data...");
      
      const seedIncidents = [
        ['INC-001', 'checkout-service', 'pool exhausted (max 10)', 'PoolExhausted', 'Connection leak in retry path', 'pool exhausted (max 10)', 'Connection leak in retry path', 'Raise pool to 25, add idle timeout, restart', 'RB-001', 'sev2', 'resolved', 'success', 'seed', 5, 0, Date.now(), Date.now()],
        ['INC-002', 'payments-api', 'ETIMEDOUT upstream stripe', 'ETIMEDOUT', 'Upstream slowness, 5s timeout too low', 'ETIMEDOUT upstream stripe', 'Upstream slowness, 5s timeout too low', 'Raise timeout to 10s, enable circuit breaker', 'RB-002', 'sev2', 'resolved', 'success', 'seed', 2, 0, Date.now(), Date.now()],
        ['INC-003', 'search-service', 'OutOfMemoryError: Java heap space', 'OutOfMemoryError', 'Unbounded in-memory cache', 'OutOfMemoryError: Java heap space', 'Unbounded in-memory cache', 'Cap cache size, restart with 4g heap', 'RB-003', 'sev1', 'resolved', 'success', 'seed', 3, 0, Date.now(), Date.now()],
        ['INC-004', 'auth-service', 'JWT expired right after issue', 'JWTExpired', 'Clock skew (NTP drift) on one node', 'JWT expired right after issue', 'Clock skew (NTP drift) on one node', 'Resync NTP, cordon node', 'RB-004', 'sev2', 'resolved', 'success', 'seed', 1, 0, Date.now(), Date.now()],
        ['INC-005', 'web-frontend', '502 Bad Gateway after deploy', 'BadGateway', 'Bad health check in new release', '502 Bad Gateway after deploy', 'Bad health check in new release', 'Roll back to previous release', 'RB-005', 'sev1', 'resolved', 'success', 'seed', 4, 1, Date.now(), Date.now()],
        ['INC-006', 'orders-worker', 'Queue depth rising, consumer lag', 'ConsumerLag', 'Poison message crash-looping consumer', 'Queue depth rising, consumer lag', 'Poison message crash-looping consumer', 'Move message to DLQ, restart consumer', 'RB-006', 'sev2', 'resolved', 'success', 'seed', 2, 0, Date.now(), Date.now()],
        ['INC-007', 'checkout-service', 'deadlock detected', 'Deadlock', 'Inconsistent lock ordering in two code paths', 'deadlock detected', 'Inconsistent lock ordering in two code paths', 'Enforce lock order, retry with backoff', 'RB-007', 'sev2', 'resolved', 'success', 'seed', 1, 1, Date.now(), Date.now()],
        ['INC-008', 'edge-gateway', '429 rate limit exceeded', 'RateLimitExceeded', 'Bot traffic burst', '429 rate limit exceeded', 'Bot traffic burst', 'Enable rate-limit rule, block ASN', 'RB-008', 'sev2', 'resolved', 'success', 'seed', 6, 0, Date.now(), Date.now()]
      ];

      for (const inc of seedIncidents) {
        this.sql`
          INSERT INTO incidents (
            id, service, signature, error_type, title, symptoms, root_cause, fix_summary, runbook_id, severity, status, outcome, source, success_count, fail_count, occurred_at, resolved_at
          ) VALUES (
            ${inc[0]}, ${inc[1]}, ${inc[2]}, ${inc[3]}, ${inc[4]}, ${inc[5]}, ${inc[6]}, ${inc[7]}, ${inc[8]}, ${inc[9]}, ${inc[10]}, ${inc[11]}, ${inc[12]}, ${inc[13]}, ${inc[14]}, ${inc[15]}, ${inc[16]}
          )
        `;
      }

      const seedRunbooks = [
        ['RB-001', 'Fix checkout pool exhaustion', 'PoolExhausted', 'checkout-service', JSON.stringify([{n: 1, description: 'Check DB connection count', action_type: null, risk: 'low'}, {n: 2, description: 'Scale connection pool', action_type: 'scale_pool', risk: 'medium'}])],
        ['RB-002', 'Fix payments API timeout', 'ETIMEDOUT', 'payments-api', JSON.stringify([{n: 1, description: 'Check upstream latency', action_type: null, risk: 'low'}, {n: 2, description: 'Enable circuit breaker', action_type: 'set_config', risk: 'medium'}])],
        ['RB-003', 'Fix search OOM', 'OutOfMemoryError', 'search-service', JSON.stringify([{n: 1, description: 'Check heap usage', action_type: null, risk: 'low'}, {n: 2, description: 'Restart service', action_type: 'restart_service', risk: 'high'}])],
        ['RB-004', 'Fix auth clock skew', 'JWTExpired', 'auth-service', JSON.stringify([{n: 1, description: 'Check NTP sync status', action_type: null, risk: 'low'}, {n: 2, description: 'Resync NTP', action_type: 'run_command', risk: 'low'}])],
        ['RB-005', 'Fix frontend bad gateway', 'BadGateway', 'web-frontend', JSON.stringify([{n: 1, description: 'Check recent deploys', action_type: null, risk: 'low'}, {n: 2, description: 'Rollback deploy', action_type: 'rollback_deploy', risk: 'high'}])],
        ['RB-006', 'Fix orders consumer lag', 'ConsumerLag', 'orders-worker', JSON.stringify([{n: 1, description: 'Check queue depth', action_type: null, risk: 'low'}, {n: 2, description: 'Move to DLQ', action_type: 'move_to_dlq', risk: 'medium'}])],
        ['RB-007', 'Fix checkout deadlock', 'Deadlock', 'checkout-service', JSON.stringify([{n: 1, description: 'Check lock wait times', action_type: null, risk: 'low'}, {n: 2, description: 'Restart service', action_type: 'restart_service', risk: 'high'}])],
        ['RB-008', 'Fix edge rate limit', 'RateLimitExceeded', 'edge-gateway', JSON.stringify([{n: 1, description: 'Check top IPs', action_type: null, risk: 'low'}, {n: 2, description: 'Enable rate limit rule', action_type: 'set_config', risk: 'medium'}])]
      ];

      for (const rb of seedRunbooks) {
        this.sql`
          INSERT INTO runbooks (
            id, title, error_type, service_pattern, steps_json
          ) VALUES (
            ${rb[0]}, ${rb[1]}, ${rb[2]}, ${rb[3]}, ${rb[4]}
          )
        `;
      }
    }
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are an Incident Triage Agent.
1. When asked about active incidents, use the listIncidents tool.
2. When investigating a specific incident:
   - Call getIncidentDetails to get the context.
   - Identify the error_type from the incident details.
   - Call getRunbook for that error_type to find the mitigation steps.
   - Propose the exact steps from the runbook's steps_json to the user.
   - Do NOT execute the fix steps automatically.
   - ALWAYS ask the user to confirm which steps to run.

${getSchedulePrompt({ date: new Date() })}`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        // Phase 2: Signal Extraction Tools
        analyzeError: tool({
          description: "Analyze and normalize an error trace or log output. ALWAYS use this first when a user posts an error.",
          inputSchema: z.object({
            raw: z.string().describe("The raw error text, stack trace, or log")
          }),
          execute: async ({ raw }) => {
            const redacted = redactSecrets(raw);
            let normalized = normalizeError(redacted);
            let truncated = false;
            
            if (normalized.split('\\n').length > 100) {
              const lines = normalized.split('\\n');
              normalized = [...lines.slice(0, 60), '... [TRUNCATED] ...', ...lines.slice(-40)].join('\\n');
              truncated = true;
            }
            
            const signals = extractSignals(normalized);
            const signature = await generateSignature(signals.errorType, signals.service, normalized);
            
            return {
              service: signals.service,
              errorType: signals.errorType,
              signature,
              keywords: signals.keywords,
              truncated
            };
          }
        }),

        findSimilarIncidents: tool({
          description: "Find similar past incidents using an error signature and signals. Returns the top matches.",
          inputSchema: z.object({
            signature: z.string().describe("The error signature from analyzeError"),
            service: z.string().describe("The service name"),
            errorType: z.string().describe("The error type"),
            keywords: z.array(z.string()).describe("List of keywords from analyzeError")
          }),
          execute: async (query) => {
            // In a real app we'd query all or pre-filter. We'll fetch all active/resolved.
            const allIncidents = this.sql`SELECT * FROM incidents` as IncidentRecord[];
            const matches = findTopMatches(query, allIncidents);
            if (matches.length === 0) return { result: "no similar incident found" };
            return matches;
          }
        }),

        getIncidentDetails: tool({
          description: "Get detailed information about a specific incident.",
          inputSchema: z.object({
            id: z.string().describe("The ID of the incident (e.g. INC-001)")
          }),
          execute: async ({ id }) => {
            const rows = this.sql`SELECT * FROM incidents WHERE id = ${id}`;
            return rows.length > 0 ? rows[0] : { error: "Incident not found" };
          }
        }),

        listIncidents: tool({
          description: "List all incidents, optionally filtered by status.",
          inputSchema: z.object({
            status: z.enum(["active", "resolved", "all"]).describe("Status filter")
          }),
          execute: async ({ status }) => {
            if (status === "all") {
              return this.sql`SELECT id, title, severity, status FROM incidents`;
            } else {
              return this.sql`SELECT id, title, severity, status FROM incidents WHERE status = ${status}`;
            }
          }
        }),

        getRunbook: tool({
          description: "Get the runbook for a specific error pattern or service.",
          inputSchema: z.object({
            error_type: z.string().describe("The error type to look up (e.g. PoolExhausted)")
          }),
          execute: async ({ error_type }) => {
            const rows = this.sql`SELECT * FROM runbooks WHERE error_type = ${error_type}`;
            return rows.length > 0 ? rows[0] : { error: "No runbook found for this error type" };
          }
        }),

        // Phase 4: Approval Gate
        applyRemediation: tool({
          description: "Apply a remediation step (mutating action) to an incident. ALWAYS requires user approval.",
          inputSchema: z.object({
            incidentId: z.string().describe("The ID of the incident"),
            actionType: z.enum(["scale_pool", "restart_service", "rollback_deploy", "set_config", "move_to_dlq", "run_command"]).describe("The action type to perform"),
            params: z.any().describe("JSON parameters for the action"),
            rationale: z.string().describe("Why this action is being taken")
          }),
          needsApproval: async () => true,
          execute: async ({ incidentId, actionType, params, rationale }) => {
            // Re-validate incident exists
            const incidents = this.sql`SELECT status FROM incidents WHERE id = ${incidentId}` as { status: string }[];
            if (incidents.length === 0) return { error: "Incident not found" };

            // Create an idempotency key (hash of incidentId + actionType + params)
            const encoder = new TextEncoder();
            const data = encoder.encode(`${incidentId}|${actionType}|${JSON.stringify(params)}`);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const idempotencyKey = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
            
            // Check idempotency
            const existingLog = this.sql`SELECT * FROM action_log WHERE idempotency_key = ${idempotencyKey}`;
            if (existingLog.length > 0) {
               return { error: "Action already executed (idempotency key matched). Cannot run the exact same action twice." };
            }

            const actionId = `ACT-${Date.now()}`;
            const resultMsg = `Simulated execution of ${actionType} completed successfully`;
            
            this.sql`
              INSERT INTO action_log (
                id, idempotency_key, incident_id, action_type, params_json, rationale, status, result, simulated, executed_at
              ) VALUES (
                ${actionId}, ${idempotencyKey}, ${incidentId}, ${actionType}, ${JSON.stringify(params)}, ${rationale}, 'executed', ${resultMsg}, 1, ${Date.now()}
              )
            `;

            return {
               success: true,
               actionId,
               result: resultMsg,
               note: "This was a simulated action."
            };
          }
        }),

        // Server-side tool: runs automatically on the server
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            // Replace with a real weather API in production
            const conditions = ["sunny", "cloudy", "rainy", "snowy"];
            const temp = Math.floor(Math.random() * 30) + 5;
            return {
              city,
              temperature: temp,
              condition:
                conditions[Math.floor(Math.random() * conditions.length)],
              unit: "celsius"
            };
          }
        }),

        // Client-side tool: no execute function — the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        // Approval tool: requires user confirmation before executing
        calculate: tool({
          description:
            "Perform a math calculation with two numbers. Requires user approval for large numbers.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
          }),
          needsApproval: async ({ a, b }) =>
            Math.abs(a) > 1000 || Math.abs(b) > 1000,
          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            if (operator === "/" && b === 0) {
              return { error: "Division by zero" };
            }
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
