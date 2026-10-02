import { type FormEvent, useState } from "react";
import { describeEvidence, type Evidence, stepKind } from "./present.ts";

type Step = {
  name: string;
  status: string;
  durationMs?: number;
  error?: string;
};
type Run = {
  runId: string;
  workflow: string;
  status: string;
  durationMs: number;
  steps: Step[];
  artifact?: { model: string; name: string; version: number };
};
type Answer = {
  url: string;
  repo: string;
  defaultBranch: string;
  protected: boolean;
  evidence: Evidence;
  checkedAt: string;
  run: Run;
};
type Failure = { error: string; failedStep?: string; run?: Run };

export function App() {
  const [url, setUrl] = useState("https://github.com/denoland/deno");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Answer | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function check(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    setFailure(null);
    try {
      const res = await fetch("/api/protection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await res.json();
      if (res.ok) setResult(body);
      else setFailure(body);
    } catch (err) {
      setFailure({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Branch protection</h1>
      <p className="muted">
        This page is only a form. The answer comes from the Swamp workflow{" "}
        <code>branch-protection</code>.
      </p>
      <form onSubmit={check}>
        <label>
          Public GitHub repository
          <input
            type="url"
            value={url}
            placeholder="https://github.com/owner/repo"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>

      {failure && (
        <section className="card error">
          <h2>
            Failed{failure.failedStep ? ` at step "${failure.failedStep}"` : ""}
          </h2>
          <pre>{failure.error}</pre>
          {failure.run && <Trace run={failure.run} />}
        </section>
      )}

      {result && (
        <section className="card">
          <p className="muted">
            Is the default branch of <code>{result.repo}</code> protected?
          </p>
          <h2 className={`answer ${result.protected}`}>
            {String(result.protected)}
          </h2>
          <p>
            Default branch <code>{result.defaultBranch}</code>:{" "}
            {describeEvidence(result.evidence)}.
          </p>
          <Trace run={result.run} />
        </section>
      )}
    </main>
  );
}

function Trace({ run }: { run: Run }) {
  return (
    <div className="trace">
      <h3>Produced by Swamp</h3>
      <p className="muted">
        workflow <code>{run.workflow}</code> · run <code>{run.runId}</code> ·
        {" "}
        {run.status} in {run.durationMs}ms
      </p>
      <ol>
        {run.steps.map((s) => {
          const kind = stepKind(s.name);
          return (
            <li key={s.name} className={`step ${s.status}`}>
              <span className={`tag ${kind}`}>
                {kind === "external" ? "GitHub API" : "deterministic"}
              </span>
              <code>{s.name}</code> {s.status}
              {s.durationMs !== undefined ? ` · ${s.durationMs}ms` : ""}
              {s.error && <div className="step-error">{s.error}</div>}
            </li>
          );
        })}
      </ol>
      {run.artifact && (
        <p className="muted">
          stored as swamp data{" "}
          <code>{run.artifact.model}/{run.artifact.name}</code>{" "}
          v{run.artifact.version}
        </p>
      )}
    </div>
  );
}
