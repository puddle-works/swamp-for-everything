// The mod's own tool, declared so `tool.call` accepts its name and types its
// arguments. The generated MCP type root only lists the servers connected
// when the mod was last saved, and once it lists any, undeclared names fail.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** Runs a swamp workflow and returns its result. */
    mcp__swamp__run_workflow: {
      workflow: string
      inputs?: Record<string, unknown>
    }
  }
}
