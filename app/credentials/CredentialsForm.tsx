"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Enter an employer login. The password is encrypted IN THIS BROWSER to the
 * worker's public key before it leaves the page; only the ciphertext is
 * POSTed. The plaintext never touches the network, the server, or the DB.
 */
export interface WorkerKey { id: string; public_key: string }
export interface EmployerOption { id: string; name: string; ats: string | null; loginHost: string | null }

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

async function encryptToWorker(publicKeyB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "spki", b64ToBytes(publicKeyB64) as unknown as BufferSource, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(secret) as unknown as BufferSource);
  return bytesToB64(ct);
}

export function CredentialsForm({
  workerKey, employers, presetCompanyId, defaultUsername,
}: {
  workerKey: WorkerKey | null;
  employers: EmployerOption[];
  presetCompanyId: string | null;
  defaultUsername: string;
}) {
  const router = useRouter();
  const [companyId, setCompanyId] = useState(presetCompanyId ?? "");
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workerKey) {
    return (
      <div className="banner warn">
        <strong>No worker key yet</strong>
        <span>Run <code>node scripts/worker-key-init.ts &quot;this Mac&quot;</code> once, then reload. Credentials are encrypted to that key.</span>
      </div>
    );
  }

  const emp = employers.find((e) => e.id === companyId) ?? null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId || !username.trim() || !password) { setError("Pick an employer and enter both a username and password."); return; }
    setBusy(true);
    try {
      const secret_ciphertext = await encryptToWorker(workerKey!.public_key, password);
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: companyId, username: username.trim(), secret_ciphertext,
          encrypted_to: workerKey!.id, ats: emp?.ats ?? null, login_host: emp?.loginHost ?? null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(body.error ?? "Could not save."); setBusy(false); return; }
      setPassword(""); setUsername(defaultUsername);
      router.refresh();
    } catch {
      setError("Encryption failed in the browser. Reload and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="cred-form">
      <label>Employer
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} required>
          <option value="">Select…</option>
          {employers.map((e) => <option key={e.id} value={e.id}>{e.name}{e.ats ? ` · ${e.ats}` : ""}</option>)}
        </select>
      </label>
      <label>Username / email
        <input type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
      </label>
      <label>Password
        <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <p className="muted">Encrypted in your browser to this Mac&rsquo;s worker key before it is stored. It is never sent or saved in readable form.</p>
      {error && <p className="err">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Encrypting…" : "Save login"}</button>
    </form>
  );
}

export function RemoveButton({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    await fetch(`/api/credentials?company_id=${encodeURIComponent(companyId)}`, { method: "DELETE" }).catch(() => {});
    setBusy(false);
    router.refresh();
  }
  return <button type="button" className="link-btn" onClick={remove} disabled={busy}>{busy ? "…" : "Remove"}</button>;
}
