import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { LinkCreate } from "./LinkCreate.tsx";

interface LinkRow {
  slug: string;
  title: string;
  status: "active" | "expired" | "revoked";
  access_mode: string;
  expires_at: string;
  asks: number;
}

export function Links() {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    setLinks((await api<{ items: LinkRow[] }>("/v1/links")).items);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Ask Links</h2>
        <button type="button" className="btn-primary" onClick={() => setCreating((c) => !c)}>
          {creating ? "Close" : "New link"}
        </button>
      </div>
      {creating && (
        <LinkCreate
          initialQuery={new URLSearchParams(location.search).get("q") ?? ""}
          onCreated={load}
        />
      )}
      <table className="w-full text-left text-sm">
        <thead className="text-stone-500">
          <tr>
            <th className="py-2">Title</th>
            <th>Status</th>
            <th>Access</th>
            <th>Expires</th>
            <th>Questions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.slug} className="border-t border-stone-200">
              <td className="py-2">
                <a className="underline" href={`/a/${l.slug}`} target="_blank" rel="noreferrer">
                  {l.title}
                </a>
              </td>
              <td>{l.status}</td>
              <td>{l.access_mode}</td>
              <td>{new Date(l.expires_at).toLocaleDateString()}</td>
              <td>{l.asks}</td>
              <td className="text-right">
                {l.status === "active" && (
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={async () => {
                      if (confirm(`Revoke "${l.title}"? Askers lose access immediately.`)) {
                        await api(`/v1/links/${l.slug}/revoke`, { json: {} });
                        await load();
                      }
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
