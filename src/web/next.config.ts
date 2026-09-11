import type { NextConfig } from "next";

const staticExport = process.env.RECEIVABLEX_STATIC_EXPORT === "true";
const githubPages = process.env.GITHUB_PAGES === "true";
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "receivablex-ethonline-2026";

const nextConfig: NextConfig = {
  agentRules: false,
  transpilePackages: ["@receivablex/domain"],
  ...(staticExport ? { output: "export" as const, trailingSlash: true } : {}),
  ...(githubPages ? { basePath: `/${repositoryName}`, assetPrefix: `/${repositoryName}` } : {}),
};

export default nextConfig;
