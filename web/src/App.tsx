import { type FormEvent, useState } from "react";
import { parseOptions, percent, stepKind } from "./present.ts";

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
  llm: string;
  steps: Step[];
  artifact?: { model: string; name: string; version: number };
};
type Decision = {
  decision: string;
  reasoning: string;
  evidence: string[];
  confidence: number;
  rejected: { option: string; reason: string }[];
  checks: { name: string; passed: boolean; detail?: string }[];
  ai: { model: string; rawResponse: string };
  run: Run;
};
type Failure = { error: string; failedStep?: string; run?: Run };

export function App() {
  const [question, setQuestion] = useState(
    "Which database should we use for the orders service?",
  );
  const [context, setContext] = useState(
    "Orders need ACID transactions and joins across customers and invoices. The team has run PostgreSQL in production for years. PostgreSQL also fits our reporting tools. MongoDB was suggested for flexible schemas.",
  );
  const [options, setOptions] = useState("MongoDB\nPostgreSQL\nDynamoDB");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Decision | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function decide(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    setFailure(null);
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question,
          context,
          options: parseOptions(options),
        }),
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
      <h1>Decision</h1>
      <p className="muted">
        This page is only a form. The decision is made by the Swamp workflow
        {" "}
        <code>decide</code>.
      </p>
      <form onSubmit={decide}>
        <label>
          Question
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <label>
          Context
          <textarea
            rows={4}
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        </label>
        <label>
          Options <span className="muted">(one per line, at least two)</span>
          <textarea
            rows={4}
            value={options}
            onChange={(e) => setOptions(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Deciding…" : "Decide"}
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
          <p className="muted">Decision</p>
          <h2 className="decision">{result.decision}</h2>
          <div className="bar" title={percent(result.confidence)}>
            <div style={{ width: percent(result.confidence) }} />
          </div>
          <p className="muted">confidence {percent(result.confidence)}</p>

          <h3>Reasoning</h3>
          <p>{result.reasoning}</p>

          <h3>Evidence</h3>
          {result.evidence.length
            ? <ul>{result.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
            : <p className="muted">none cited</p>}

          <h3>Rejected</h3>
          <ul>
            {result.rejected.map((r) => (
              <li key={r.option}>
                <strong>{r.option}</strong>: {r.reason}
              </li>
            ))}
          </ul>

          <h3>Checks</h3>
          <ul className="checks">
            {result.checks.map((c) => (
              <li key={c.name}>
                {c.passed ? "✓" : "✗"} {c.name}
                {c.detail ? ` (${c.detail})` : ""}
              </li>
            ))}
          </ul>

          <Trace run={result.run} />

          <details>
            <summary>Raw AI output ({result.ai.model})</summary>
            <pre>{result.ai.rawResponse}</pre>
          </details>
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
        {run.status} in {run.durationMs}ms · llm <code>{run.llm}</code>
      </p>
      <ol>
        {run.steps.map((s) => {
          const kind = stepKind(s.name);
          return (
            <li key={s.name} className={`step ${s.status}`}>
              <span className={`tag ${kind}`}>
                {kind === "ai" ? "AI" : "deterministic"}
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
