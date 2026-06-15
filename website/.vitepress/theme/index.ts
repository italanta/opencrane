import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { theme, useOpenapi } from 'vitepress-openapi/client'
import 'vitepress-openapi/dist/style.css'
import './custom.css'
import spec from '../../public/openapi.json' with { type: 'json' }

// Register the OpenCrane control-plane spec globally so the <OASpec /> component
// on the API reference page renders without a per-page :spec prop. The spec is
// copied in from apps/control-plane by scripts/sync-openapi.mjs (predev/prebuild).
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    useOpenapi({ spec })
    theme.enhanceApp({ app })
  },
} satisfies Theme
