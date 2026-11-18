/** A tool failure the MCP client can see. `isError` must be true: a text body alone is reported as success. */
export function toolFailure(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
  };
}
