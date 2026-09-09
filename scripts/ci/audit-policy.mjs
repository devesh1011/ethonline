const severity = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** Exceptions bind advisory + exact installed versions, never a blanket severity threshold. */
export function evaluateAudit(audit, lock, exceptions, now = new Date()) {
  const failures = [], accepted = [];
  if (audit.error || !audit.vulnerabilities || !audit.metadata) return { failures: ["Audit response unavailable or malformed"], accepted };
  for (const [name, vulnerability] of Object.entries(audit.vulnerabilities)) {
    for (const advisory of vulnerability.via.filter(value => typeof value === "object")) {
      const versions = [...new Set(vulnerability.nodes.map(path => lock.packages[path]?.version))];
      const exception = exceptions.find(entry => entry.package === name && entry.advisories.includes(advisory.url));
      if (!exception) { failures.push(`Unreviewed ${name}: ${advisory.url}`); continue; }
      if (Date.parse(`${exception.expires}T23:59:59Z`) < now.getTime() || !Number.isFinite(Date.parse(exception.expires))) { failures.push(`Expired ${name} exception (${exception.expires})`); continue; }
      if (!exception.reason || severity[advisory.severity] === undefined || severity[exception.maxSeverity] === undefined || severity[advisory.severity] > severity[exception.maxSeverity]) { failures.push(`Unreviewed severity/reason for ${name}: ${advisory.url}`); continue; }
      if (versions.some(version => !version || !exception.versions.includes(version))) { failures.push(`Unreviewed ${name} versions: ${versions.join(", ")}`); continue; }
      accepted.push({ package: name, advisory: advisory.url, versions, severity: advisory.severity, expires: exception.expires });
    }
  }
  return { failures, accepted };
}
