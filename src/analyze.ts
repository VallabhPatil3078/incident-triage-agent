export function redactSecrets(text: string): string {
	let redacted = text;
	// Emails
	redacted = redacted.replace(
		/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
		"<REDACTED>"
	);
	// Bearer tokens / API keys
	redacted = redacted.replace(
		/Bearer\s+[A-Za-z0-9\-_~+/]+=*/g,
		"Bearer <REDACTED>"
	);
	redacted = redacted.replace(
		/api_key\s*=\s*[A-Za-z0-9\-_~+/]+/g,
		"api_key=<REDACTED>"
	);
	// Basic JWT pattern
	redacted = redacted.replace(
		/ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
		"<REDACTED>"
	);
	// AWS Keys
	redacted = redacted.replace(/(AKIA|ASIA)[0-9A-Z]{16}/g, "<REDACTED>");
	return redacted;
}

export function normalizeError(text: string): string {
	let normalized = text;

	// Strip timestamps (various formats)
	normalized = normalized.replace(
		/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g,
		"<TS>"
	);
	normalized = normalized.replace(
		/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/g,
		"<TS>"
	);

	// UUIDs
	normalized = normalized.replace(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
		"<UUID>"
	);

	// Hex addresses
	normalized = normalized.replace(/0x[0-9a-f]+/gi, "<ADDR>");

	// IPs
	normalized = normalized.replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, "<IP>");

	// Line and column numbers
	normalized = normalized.replace(/:\d+:\d+/g, ":<N>:<N>");
	normalized = normalized.replace(/line \d+/gi, "line <N>");

	// Absolute paths to placeholders (e.g. /usr/src/app or C:\)
	normalized = normalized.replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, "<PATH>");
	normalized = normalized.replace(/[A-Z]:\\[a-zA-Z0-9._\\\-]+/gi, "<PATH>");

	// Collapse repeated identical lines
	const lines = normalized.split("\n");
	const collapsed: string[] = [];
	let lastLine = "";
	let count = 0;

	for (const line of lines) {
		if (line === lastLine) {
			count++;
		} else {
			if (count > 1) {
				collapsed.push(`... x ${count}`);
			}
			collapsed.push(line);
			lastLine = line;
			count = 1;
		}
	}
	if (count > 1) {
		collapsed.push(`... x ${count}`);
	}

	return collapsed.join("\n");
}

export async function generateSignature(
	errorType: string,
	service: string,
	normalizedText: string
): Promise<string> {
	const lines = normalizedText
		.split("\n")
		.filter((l) => l.trim().length > 0 && !l.startsWith("... x"));
	const firstExceptionLine = lines[0] || "";
	const topFrames = lines.slice(1, 4).join("\n");

	const base = `${errorType}|${service}|${firstExceptionLine}|${topFrames}`;

	// Use crypto subtly for signature
	const encoder = new TextEncoder();
	const data = encoder.encode(base);
	const hashBuffer = await crypto.subtle.digest("SHA-1", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractSignals(text: string) {
	let errorType = "unknown";
	let service = "unknown";
	const keywords: string[] = [];

	// Try to find error classes
	const errorMatch = text.match(/([a-zA-Z0-9_]+(?:Exception|Error))/);
	if (errorMatch) errorType = errorMatch[1];
	else if (text.includes("ETIMEDOUT")) errorType = "ETIMEDOUT";
	else if (text.includes("deadlock detected")) errorType = "Deadlock";
	else if (text.includes("pool exhausted")) errorType = "PoolExhausted";

	// HTTP Codes
	const httpMatch = text.match(/\b(502|503|504|500|429|401|403)\b/);
	if (httpMatch) keywords.push(`HTTP ${httpMatch[1]}`);

	// Service hints
	const serviceMatch = text.match(
		/([a-z0-9-]+-service|[a-z0-9-]+-api|[a-z0-9-]+-worker|web-frontend|edge-gateway)/i
	);
	if (serviceMatch) service = serviceMatch[1].toLowerCase();

	return { errorType, service, keywords };
}
