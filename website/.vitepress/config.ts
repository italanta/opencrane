import { defineConfig } from 'vitepress'

// Served at the opencrane.ai custom domain (see website/public/CNAME), so base
// stays '/'. DOCS_BASE can override it (e.g. '/opencrane/') for project-pages hosting.
const base = process.env.DOCS_BASE ?? '/'

const REPO = 'https://github.com/italanta/opencrane'

export default defineConfig({
  base,
  lang: 'en-GB',
  title: 'OpenCrane',
  description:
    'Self-hosted, Kubernetes-native control plane for organizational AI — a private AI assistant for every employee, on your own infrastructure.',
  cleanUrls: true,
  lastUpdated: true,
  // Architecture diagrams in the docs use Unicode box-drawing; keep them intact.
  ignoreDeadLinks: false,

  head: [
    // base-aware so the favicon resolves under project pages (/opencrane/) too.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#14a8c4' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    search: { provider: 'local' },

    nav: [
      { text: 'Start here', link: '/guide/introduction' },
      {
        text: 'Guides',
        items: [
          { text: 'Employee assistants', link: '/guide/first-tenant' },
          { text: 'Organize your company', link: '/guide/organize' },
          { text: 'Share skills', link: '/guide/skills' },
          { text: 'Manage tools (MCP)', link: '/guide/tools' },
          { text: 'Organizational knowledge', link: '/guide/knowledge' },
          { text: 'Control access', link: '/guide/permissions' },
          { text: 'Manage cost', link: '/guide/budgets' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'API (interactive)', link: '/reference/api' },
          { text: 'API overview', link: '/reference/api-overview' },
        ],
      },
      { text: 'GitHub', link: REPO },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'What is OpenCrane?', link: '/guide/introduction' },
          { text: 'How OpenCrane works', link: '/guide/how-it-works' },
        ],
      },
      {
        text: 'Get set up',
        items: [
          {
            text: '1. Install OpenCrane',
            link: '/guide/getting-started',
            items: [
              { text: 'Local, VM or VPS', link: '/guide/deploy-local' },
              { text: 'Cluster deployment', link: '/guide/deploy-cluster' },
            ],
          },
          { text: '2. Set up your domain', link: '/guide/dns' },
          { text: '3. Create your first assistant', link: '/guide/first-tenant' },
          { text: '4. Connect to OpenClaw', link: '/guide/connect' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Employee assistants', link: '/guide/first-tenant' },
          { text: 'Organize your company', link: '/guide/organize' },
          { text: 'Share skills across teams', link: '/guide/skills' },
          { text: 'Manage tools (MCP)', link: '/guide/tools' },
          { text: 'Organizational knowledge', link: '/guide/knowledge' },
          { text: 'Control who can access what', link: '/guide/permissions' },
          { text: 'Manage cost', link: '/guide/budgets' },
          { text: 'Review activity', link: '/guide/audit' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI reference', link: '/reference/cli' },
          { text: 'API reference (interactive)', link: '/reference/api' },
          { text: 'API overview', link: '/reference/api-overview' },
          { text: 'Contracts SDK', link: '/integrators/contracts-sdk' },
        ],
      },
      {
        text: 'Operating OpenCrane',
        collapsed: true,
        items: [
          { text: 'Hosting & deployment', link: '/operators/hosting' },
          { text: 'DNS configuration', link: '/operators/dns-config' },
          { text: 'Identity & connection auth', link: '/security/identity' },
          { text: 'Connection security', link: '/security/connection-security' },
          { text: 'Runbook', link: '/operators/runbook' },
          { text: 'Awareness SLOs', link: '/operators/awareness-slos' },
        ],
      },
      {
        text: 'Deep dives',
        collapsed: true,
        items: [
          { text: 'MCP gateway (Obot)', link: '/integrators/mcp-gateway' },
          { text: 'Skill registry & delivery', link: '/integrators/skill-registry' },
          { text: 'Retrieval & memory (Cognee)', link: '/integrators/retrieval-memory' },
        ],
      },
      {
        text: 'Advanced',
        collapsed: true,
        items: [
          { text: 'Architecture', link: '/advanced/architecture' },
          { text: 'Running multiple instances', link: '/advanced/multi-instance' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: REPO }],

    editLink: {
      pattern: `${REPO}/edit/main/website/:path`,
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the AGPL-3.0-or-later License.',
      copyright: 'OpenCrane — self-hosted control plane for organizational AI.',
    },
  },
})
