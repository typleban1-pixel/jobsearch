/**
 * The text of a frozen profile row, as the grounding checks read it.
 *
 * One definition, because two would drift. A claim is judged against the
 * evidence's TEXT, so anything the row states but this function omits is
 * invisible to the guards and will be reported as an invention. The
 * summary line "Experience since 2016" was rejected for exactly that: the
 * year is in the employment record's start_month, and the extractor was
 * only reading responsibilities and accomplishments.
 */
export function evidenceTextOf(sourceTable: string, row: Record<string, any>): string {
  const parts: Array<string | null | undefined> = [
    row["summary"], row["detail"], row["approved_wording"], row["name"],
    row["description"], row["notes"], row["statement"], row["label"],
    ...(row["responsibilities"] ?? []), ...(row["accomplishments"] ?? []),
    ...(row["tools"] ?? []),
  ];

  if (sourceTable === "employment_records") {
    parts.push(row["employer"], row["actual_title"], row["display_title"], row["location"]);
    // Dates are facts the row states. A claim about when something
    // happened is grounded in them or it is grounded in nothing.
    for (const k of ["start_month", "end_month"]) {
      const v = row[k];
      if (typeof v === "string" && v.length >= 4) parts.push(v.slice(0, 4));
    }
    if (row["is_current"]) parts.push("current present");
  }
  if (sourceTable === "education") {
    parts.push(row["institution"], row["credential"], row["field_of_study"]);
    const end = row["end_date"];
    if (typeof end === "string" && end.length >= 4) parts.push(end.slice(0, 4));
  }
  if (sourceTable === "skills") parts.push(row["name"], row["level"], ...(row["related_terms"] ?? []));

  return parts.filter(Boolean).join(" ");
}

/**
 * The individual STATEMENTS a row makes, for qualifier and scope
 * comparison. Separate from evidenceTextOf because the two answer
 * different questions: that one asks what vocabulary the row contains,
 * this one asks which sentences a claim can be matched against.
 *
 * Lives here so there is one definition. Four diagnostics had each grown
 * a private copy that omitted `summary` and `detail`, which are the only
 * fields an evidence row has, so every evidence citation read as an
 * empty source and legitimate claims were reported as inventions.
 */
export function provenanceStatements(row: Record<string, any>): string[] {
  return [row["approved_wording"], row["statement"], row["description"], row["summary"],
    ...(Array.isArray(row["responsibilities"]) ? row["responsibilities"] : []),
    ...(Array.isArray(row["accomplishments"]) ? row["accomplishments"] : [])]
    .filter((x) => typeof x === "string" && x.trim().length > 12);
}
