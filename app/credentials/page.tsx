import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../lib/portal/session.ts";
import { CredentialsForm, RemoveButton, type EmployerOption, type WorkerKey } from "./CredentialsForm.tsx";

export const dynamic = "force-dynamic";

// Sources that put the application behind an account the worker must log into.
// Greenhouse/Lever/Ashby forms are account-less, so they never need a login.
const ACCOUNT_ATS = ["WORKDAY"];

export default async function CredentialsPage(
  { searchParams }: { searchParams: Promise<{ company?: string }> },
) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const db = session.client;
  const preset = (await searchParams).company ?? null;

  const { data: keyRow } = await db.from("worker_public_keys")
    .select("id,public_key").is("revoked_at", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const workerKey: WorkerKey | null = keyRow ? { id: keyRow.id, public_key: keyRow.public_key } : null;

  // Employers with open account-based jobs — the ones that need a login.
  const jobRows: Array<{ company_id: string | null }> = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from("jobs").select("company_id")
      .eq("status", "OPEN").in("source", ACCOUNT_ATS).range(f, f + 999);
    if (!data?.length) break;
    jobRows.push(...data);
    if (data.length < 1000) break;
  }
  const companyIds = [...new Set(jobRows.map((j) => j.company_id).filter(Boolean) as string[])];
  const comps = companyIds.length
    ? (await db.from("companies").select("id,name").in("id", companyIds)).data ?? []
    : [];
  const { data: tenants } = await db.from("workday_tenants").select("company_id,host");
  const hostByCompany = new Map((tenants ?? []).map((t) => [t.company_id, t.host as string]));
  const employers: EmployerOption[] = comps
    .map((c) => ({ id: c.id as string, name: c.name as string, ats: "Workday", loginHost: hostByCompany.get(c.id) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const { data: creds } = await db.from("portal_credentials")
    .select("company_id,username,ats,login_host,updated_at");
  const nameById = new Map(employers.map((e) => [e.id, e.name]));
  const missing = (creds ?? []).map((c) => c.company_id as string).filter((id) => !nameById.has(id));
  if (missing.length) {
    const { data: more } = await db.from("companies").select("id,name").in("id", missing);
    for (const c of more ?? []) nameById.set(c.id as string, c.name as string);
  }

  return (
    <main className="wrap">
      <p className="back"><Link href="/jobs">← all jobs</Link> · <Link href="/handoff">handoff</Link></p>
      <h1>Application logins</h1>
      <p className="muted">
        Accounts you create on employer sites (Workday and the like) so a run can sign in for you.
        Passwords are encrypted in your browser to this Mac&rsquo;s worker key and are never stored or sent in readable form.
      </p>

      <h2>Add or replace a login</h2>
      <CredentialsForm workerKey={workerKey} employers={employers} presetCompanyId={preset} />

      <h2>Saved logins</h2>
      {(creds ?? []).length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <table className="cred-table">
          <thead><tr><th>Employer</th><th>Username</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {(creds ?? []).map((c) => (
              <tr key={c.company_id as string}>
                <td>{nameById.get(c.company_id as string) ?? (c.login_host as string) ?? (c.company_id as string)}</td>
                <td>{c.username as string}</td>
                <td>{new Date(c.updated_at as string).toLocaleDateString()}</td>
                <td><RemoveButton companyId={c.company_id as string} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
