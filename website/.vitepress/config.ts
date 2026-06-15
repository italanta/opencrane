import { defineConfig } from 'vitepress'

// `base` defaults to '/' (custom domain docs.opencrane.ai via public/CNAME). The
// GitHub Pages workflow can override it with DOCS_BASE (e.g. '/opencrane-2/') when
// publishing to project pages instead of a custom domain.
const base = process.env.DOCS_BASE ?? '/'

const REPO = 'https://github.com/opencrane/opencrane'

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
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#14a8c4' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    search: { provider: 'local' },

    nav: [
      { text: 'Introduction', link: '/guide/introduction' },
      { text: 'Getting Started', link: '/guide/getting-started' },
      { text: 'Concepts', link: '/concepts/tenancy' },
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
        text: 'Introduction',
        items: [
          { text: 'What is OpenCrane?', link: '/guide/introduction' },
          { text: 'Architecture overview', link: '/guide/architecture' },
        ],
      },
      {
        text: 'Getting Started',
        items: [
          { text: 'Prerequisites & install', link: '/guide/getting-started' },
          { text: 'Local & GCP deployment', link: '/guide/deployment' },
          { text: 'Create your first tenant', link: '/guide/first-tenant' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'ClusterTenant vs UserTenant', link: '/concepts/tenancy' },
          { text: 'The five planes & IAM-first identity', link: '/concepts/iam' },
          { text: 'Access policies & grants', link: '/concepts/access-policies' },
          { text: 'Awareness contract & retrieval', link: '/concepts/awareness' },
        ],
      },
      {
        text: 'Operators',
        items: [
          { text: 'Hosting architecture', link: '/operators/hosting' },
          { text: 'Multi-instance', link: '/operators/multi-instance' },
          { text: 'Runbook', link: '/operators/runbook' },
          { text: 'Awareness SLOs', link: '/operators/awareness-slos' },
        ],
      },
      {
        text: 'Integrators',
        items: [
          { text: 'MCP gateway (Obot)', link: '/integrators/mcp-gateway' },
          { text: 'Skill registry & delivery', link: '/integrators/skill-registry' },
          { text: 'Retrieval & memory (Cognee)', link: '/integrators/retrieval-memory' },
          { text: 'Contracts SDK', link: '/integrators/contracts-sdk' },
        ],
      },
      {
        text: 'Security',
        items: [
          { text: 'Identity & connection auth', link: '/security/identity' },
          { text: 'Connection security model', link: '/security/connection-security' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI reference', link: '/reference/cli' },
          { text: 'API reference (interactive)', link: '/reference/api' },
          { text: 'API overview', link: '/reference/api-overview' },
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
