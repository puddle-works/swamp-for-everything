# Swamp for Everything

A place to test different ways of using [Swamp](https://swamp.club).

Each spike lives in its own folder under `spikes/`, with its own swamp repo,
tasks and README. Run a spike's commands from its folder.

| Spike                                                  | What it tests                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [branch-protection-api](spikes/branch-protection-api/) | Spike 1: a deterministic HTTP API that asks swamp whether a branch is protected |
| [claude-mod](spikes/claude-mod/)                       | #17: a Claude Code mod that gives Claude a tool to run swamp workflows          |
| [jev-router](spikes/jev-router/)                       | #16: Jev's API, answered by spike 1's swamp check where one exists, else by Jev |
