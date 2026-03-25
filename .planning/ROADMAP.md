# Roadmap: NanoClaw Agent Fleet

## Overview

NanoClaw is a lightweight, single-process AI agent system running Claude in isolated containers. This roadmap tracks the phased rollout from initial setup through advanced agent capabilities for the Fleet PM use case.

## Phases

- [x] **Phase 01: Setup** - Initial installation, Slack registration, service configuration
- [x] **Phase 02: Core Agent** - KICKOFF execution, T1-T13 validation, end-to-end pipeline confirmed
- [ ] **Phase 03: Advanced Features** - File uploads, cost tracking, additional integrations

## Phase Details

### Phase 01: Setup
**Goal**: NanoClaw installed, Slack connected, sender allowlist configured
**Depends on**: Nothing (first phase)
**Success Criteria**:
  1. NanoClaw process running on production server
  2. Slack channels registered and responding to trigger word
  3. Sender allowlist enforced for authorized users

Plans:
- [x] 01-01: Installation and Slack skill setup

### Phase 02: Core Agent
**Goal**: All KICKOFF steps implemented and validated through T1-T13 test suite
**Depends on**: Phase 01
**Success Criteria**:
  1. All 11 KICKOFF steps running in production
  2. Fleet PM identity active with correct Slack formatting
  3. Linear + GitHub integrations working end-to-end
  4. T1-T13 test suite: 11/13 full pass (T6, T9 partial — documented)

Plans:
- [x] 02-01: KICKOFF execution (all 11 steps + post-KICKOFF fixes)
- [x] 02-02: T1-T13 validation (11 full pass, 2 partial)

### Phase 03: Advanced Features
**Goal**: File upload IPC validated in production, cost tracking added, Phase 3 capabilities
**Depends on**: Phase 02
**Success Criteria**:
  1. T19: uploadFile IPC triggers correctly with real file-producing task
  2. Cost tracking reports available via Slack
  3. TBD additional capabilities

Plans:
- [ ] 03-01: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 01. Setup | 1/1 | Complete | 2026-03-25 |
| 02. Core Agent | 2/2 | Complete    | 2026-03-25 |
| 03. Advanced Features | 0/TBD | Not started | - |
