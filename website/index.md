---
layout: home

hero:
  name: OpenCrane
  text: A control plane for organizational AI
  tagline: >-
    Self-hosted, Kubernetes-native. Issue a private AI assistant to every
    employee while keeping your skills, knowledge, and conversations on your own
    infrastructure.
  image:
    src: /logo.svg
    alt: OpenCrane
  actions:
    - theme: brand
      text: What is OpenCrane?
      link: /guide/introduction
    - theme: alt
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/opencrane/opencrane

features:
  - title: Personal assistants at scale
    details: >-
      Each employee gets an isolated OpenClaw pod with dedicated, encrypted
      storage — from 10 to 10,000 employees on the same architecture.
  - title: Vendor independence
    details: >-
      Choose your LLM provider — Claude, GPT, or open-source models — and keep
      your proprietary skills in your own repository. No lock-in.
  - title: Data sovereignty
    details: >-
      Organizational knowledge, conversations, and skills stay on your network.
      Full audit trails, RBAC, and data residency under your control.
  - title: API-first & headless
    details: >-
      Every capability is reachable through the versioned REST API and the oc
      CLI. The OpenAPI 3.1 spec is the contract; external UIs are just clients.
  - title: IAM-first identity
    details: >-
      Workload Identity for pods, OIDC for operators, audience-bound projected
      tokens for in-cluster planes. Secrets never reach tenant pods.
  - title: Self-hosted, cloud-agnostic
    details: >-
      On-prem by default with optional cloud adapters. Helm + Terraform IaC;
      runs with zero cloud SDKs present.
---
