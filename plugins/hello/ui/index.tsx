import { h, Fragment, useState, useEffect, useCallback, ui, toast } from "./host";

// Minimal copy of AdminUiPluginApi from @beamhop/sdk/ui-contract (type-only)
interface Api {
  pluginName: string;
  registerPage(p: { path: string; title: string; component: unknown }): void;
  registerWidget(w: { id: string; title: string; size?: "sm" | "md" | "lg"; component: unknown }): void;
  registerUserAction(a: { id: string; label: string; destructive?: boolean; run(pubkey: string): Promise<void> | void }): void;
  registerEventAction(a: { id: string; label: string; destructive?: boolean; run(eventId: string): Promise<void> | void }): void;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
interface Stats { seen: number; rejected: number; recent: { id: string; pubkey: string; at: number; reason: string }[] }

const Card = ui("Card", "section");
const Button = ui("Button", "button");
const Badge = ui("Badge", "span");

function useStats(api: Api) {
  const [stats, setStats] = useState<Stats | null>(null);
  const load = useCallback(async () => {
    const res = await api.fetch("/stats");
    if (res.ok) setStats(await res.json());
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  return { stats, load };
}

export default function register(api: Api) {
  function HelloPage() {
    const { stats, load } = useStats(api);
    const reset = async () => {
      await api.fetch("/reset", { method: "POST" });
      toast("Counters reset");
      load();
    };
    return (
      <div style={{ display: "grid", gap: "1rem", padding: "1rem" }}>
        <h2 style={{ margin: 0 }}>Hello plugin</h2>
        <p style={{ opacity: 0.7, margin: 0 }}>Events seen and rejected by the example write hook.</p>
        <div style={{ display: "flex", gap: ".5rem" }}>
          <Badge>seen: {stats?.seen ?? "…"}</Badge>
          <Badge>rejected: {stats?.rejected ?? "…"}</Badge>
        </div>
        <Card style={{ padding: "1rem" }}>
          {stats?.recent.length ? (
            <ul style={{ margin: 0, paddingLeft: "1rem" }}>
              {stats.recent.map((r) => (
                <li key={r.id}>
                  <code>{r.pubkey.slice(0, 12)}…</code> {r.reason} · {new Date(r.at * 1000).toLocaleString()}
                </li>
              ))}
            </ul>
          ) : (
            <Fragment>No rejections yet.</Fragment>
          )}
        </Card>
        <div>
          <Button onClick={reset}>Reset counters</Button>
        </div>
      </div>
    );
  }

  function HelloWidget() {
    const { stats } = useStats(api);
    return (
      <div style={{ fontSize: "2rem", fontWeight: 600 }}>
        {stats ? stats.rejected : "…"}
        <div style={{ fontSize: ".8rem", opacity: 0.7, fontWeight: 400 }}>events blocked by hello</div>
      </div>
    );
  }

  api.registerPage({ path: "/hello", title: "Hello", component: HelloPage });
  api.registerWidget({ id: "hello-rejected", title: "Hello plugin", size: "sm", component: HelloWidget });
  api.registerUserAction({
    id: "hello-greet",
    label: "Say hello (example)",
    run: (pubkey) => toast(`Hello ${pubkey.slice(0, 8)}…!`),
  });
}
