<p align="center"><img src="docs/assets/readme-banner.svg" alt="CI Diet" width="820"></p>

# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ci-diet"><img src="https://img.shields.io/npm/v/dsh-ci-diet.svg" alt="npm 버전"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="라이선스: MIT"></a>
  <a href="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml"><img src="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

**낭비 가능성이 높은 GitHub Actions 러너 시간을 찾아 근거를 남기고, 작은 수정안을 사람이 검토할 수 있는 계획으로 만듭니다.**

CI Diet는 알파 단계의 CLI이자 DeepSeek Harness(DSH) 플러그인입니다. workflow 정의와, 켜져 있을 때 GitHub Actions 이력을 읽고 발견 사항을 보여줍니다. workflow는 스스로 바꾸지 않고 좁은 범위의 YAML 수정안을 준비합니다.

## 설치

CLI는 Node `^22.19.0 || >=24.0.0`이 필요합니다. 현재 npm 릴리스는 `0.5.2`입니다.

```bash
npm install --global dsh-ci-diet@0.5.2
ci-diet --version
dsh plugin --profile web add dsh-ci-diet@0.5.2
dsh --profile web
```

플러그인은 DSH 도구와 **Settings → CI Diet**, **CI Diet 검토** 화면을 등록합니다. 설치만으로 저장소를 스캔하거나 러너 시간을 줄이거나 workflow를 수정하지 않습니다. 전역 CLI를 설치하지 않았다면 `ci-diet` 대신 `npx dsh-ci-diet@0.5.2`를 쓰면 됩니다.

## 첫 스캔과 이력

확인할 저장소에서 아래 명령을 실행합니다. 정적 스캔은 오프라인으로 실행되고 보고서를 저장합니다. 이력 동기화는 인증된 `gh` CLI에서 읽기 전용 GitHub API 요청으로 최근 실행과 job을 읽는 별도 네트워크 단계입니다.

```bash
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`gh`에는 저장소의 Actions 실행과 job 읽기 권한이 필요합니다. CI Diet는 GitHub 쓰기 권한을 요구하지 않습니다. HTML 보고서는 인라인 CSS를 쓴 자체 완결형 파일 하나이며 스크립트와 외부 요청이 없습니다. DSH에서는 `ci_diet_scan`과 `ci_diet_sync`가 모두 보고서를 저장하며, 새 플러그인 프로필은 네트워크 접근과 preflight가 기본으로 켜져 있습니다.

![스캔, 미리보기, 사람의 승인, 적용, 측정으로 이어지는 CI Diet 흐름](docs/assets/workflow.svg)

## 찾는 것

<p align="center">
  <img src="docs/assets/settings-preview.png" alt="한국어 UI에서 preflight가 기본으로 켜진 CI Diet 설정 화면" width="560">
</p>
<p align="center"><sub>Settings → CI Diet 설정 화면입니다. 한국어 UI이며 preflight는 기본으로 켜져 있습니다.</sub></p>

| 규칙 | 기본값 | 찾는 것 | 보통의 결과 |
| --- | --- | --- | --- |
| CD001 | 켜짐 | 더 새 커밋 때문에 불필요해진 PR 실행 | `concurrency` 계획 |
| CD002 | 켜짐 | 겹치거나 중복된 트리거 후보 | 설명 |
| CD003 | 꺼짐 | 선언된 문서 전용 변경에 실행되는 무거운 검사 | 설명 |
| CD004 | 켜짐 | 정적으로 풀 수 있는 큰 matrix | 검토 메모 |
| CD005 | 꺼짐 | timeout이 없는 job | 측정된 `timeout-minutes` 계획 |
| CD006 | 켜짐 | 명시적 캐시 없이 실행되는 지원 대상 npm, pnpm, Bun frozen install | 다운로드 캐시 계획 |
| CD008 | 켜짐 | 필요한 기간보다 긴 artifact 보존 | 사람 확인을 거치는 `retention-days` 계획 |

CD003과 CD005는 기본으로 꺼져 있습니다. CD002, CD003, CD004는 patch를 만들지 않습니다. CD005는 비정상 실행을 제한할 뿐 정상 실행 시간을 줄이지 않습니다. CD008은 artifact storage의 보존 기간을 바꾸며 runner minutes를 바꾸지 않습니다. 모든 계획은 검토하고 결과를 측정하기 전까지 가설입니다.

## 지원되는 npm 캐시 예시

CD006은 지원되는 `actions/setup-node@v4` 단계 뒤에 `npm ci`가 오고, 추적 중인 manifest와 lockfile이 있는 좁은 형태를 인식합니다. 계획은 캐시 입력만 추가하며 버전, 설치, 테스트는 그대로 둡니다.

**변경 전**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
```

**변경 후**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: package-lock.json
      - run: npm ci
```

계획 명령에서 `--step 1`은 이 YAML 배열의 두 번째 단계를 뜻합니다. checkout이 `0`, setup-node가 `1`입니다. 단계 이름이 아니라 0부터 세는 인덱스입니다. pnpm, Bun, timeout, 보존 기간과 현재 guard는 [플러그인 안내](docs/guide/plugin.md)를 보세요.

## 쓰기 전 검토

흐름은 **scan → preview → human approval → apply → measure**입니다. `ci_diet_plan`을 포함한 모델 도구는 수정안과 plan digest만 미리 보여 주며 승인, 적용, 되돌리기를 할 수 없습니다. 검토 화면에서는 사람이 plan digest 끝자리나 change ID를 입력한 뒤 승인, 적용, 되돌리기를 할 수 있습니다. 로컬 쓰기는 기존 workflow 파일 하나의 지정된 바이트 범위만 고칩니다.

```bash
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet measure --cwd . --change CHANGE_ID --before-runs 100,101 --after-runs 110,111 --network
ci-diet revert --cwd . --change CHANGE_ID
```

승인은 그 계획 하나에만 유효합니다. 적용은 백업을 만들고 계획된 바이트를 고친 뒤 source, dependency, policy, digest, lock, backup을 확인합니다. 되돌리기는 백업을 복원합니다. CI Diet는 commit, push, deploy, workflow 실행, branch protection 변경, artifact 삭제를 하지 않습니다.

## 근거와 솔직한 한계

- 측정 전에는 절감을 주장하지 않습니다. 이력이나 workflow 귀속이 불완전하면 발견이 틀릴 수 있습니다.
- dependency cache는 restore와 save 시간을 더할 수 있습니다. 줄이는 설치 시간보다 cache overhead가 클 수 있으니 조건이 같은 cold 실행과 warm 실행을 비교하고 cache 단계도 포함하세요.
- `measure`는 선택한 실제 실행을 비교해 관찰된 runner-time 차이와 성공, 재실행률을 보여줍니다. 그 표본에 대한 근거일 뿐 인과관계나 실제 청구 금액의 증명이 아닙니다.
- Settings 화면은 도구 설정을 저장하고 세션에 묶인 보고서와 계획을 보여줍니다. 스스로 workflow를 최적화하지 않습니다.
- 정책과 근거 확인 때문에 유용한 수정도 막힐 수 있습니다. 변경을 남기기 전에 보고서, diff, 저장소 자체 검사를 확인하세요.

| 값 | 의미 |
| --- | --- |
| `observedRunnerSeconds` | 수집한 실행에서 관찰한 러너 시간 |
| `modeledRoundedMinutes` | job별 분을 올림한 모델링 값이며 추정치일 뿐입니다 |
| `listPriceUsd` | 내장된 가격 스냅샷 기준의 정가 추정치 |
| `actualBilledUsd` | 실제 청구서를 입증할 수 있을 때까지 `unknown` |

이 값을 따로 보관하므로 모델링한 분이 실제 청구액처럼 보이지 않습니다.

## 문서

| 필요한 내용 | 읽을 문서 |
| --- | --- |
| 설치, 설정, CLI, 검토, 측정 | [플러그인 안내](docs/guide/plugin.md) · [측정 절](docs/guide/plugin.md#measuring-an-applied-change) |
| 규범 제품 설명과 계약 지도 | [사양 색인](docs/spec/README.md) |
| 규칙 guard, 비용 모델, patch, storage | [규칙](docs/spec/rules.md) · [비용 모델](docs/spec/cost-model.md) · [patch 모델](docs/spec/patch-model.md) · [storage](docs/spec/storage.md) |
| 실제 cache overhead 측정 | [2026-10-25 캐시 검토](docs/measurements/2026-10-25-cache-review.md) |

<details>
<summary>플러그인 기본값, 마이그레이션, 호환성</summary>

새 DSH 프로필은 `preflightEnabled`, `networkEnabled`, `localApplyEnabled`와 CD001, CD002, CD004, CD006, CD008을 켭니다. 일회성 마이그레이션은 `defaultsRevision: 2`를 기록하며, 이후 바꾼 스위치와 규칙 선택은 재시작 뒤에도 유지됩니다. CD003과 CD005는 직접 켜기 전까지 꺼져 있습니다. 상태 경로, 보존 기간, 쿼터, 기존 비용 입력은 보존됩니다.

플러그인은 DSH `>=0.2.1-rc.2 <0.3.0-0`과 `>=0.2.2-rc.1 <0.3.0-0`을 대상으로 합니다. DSH `0.3.0`은 지원하지 않습니다. 플러그인 preflight는 지원되는 배포 명령을 실행 전에 확인하지만 네트워크 요청이나 파일 변경을 하지 않고 불투명한 shell은 건너뜁니다. CLI 이력에는 `--network`가 필요하고, 플러그인 네트워크 스위치는 sync 도구를 호출할 때만 `gh` 호출을 허용합니다. 같은 명령에 `@latest`를 써서 업데이트한 뒤 DSH를 다시 시작하세요.

</details>

## 기여와 라이선스

버그와 범위가 분명한 제안은 [GitHub Issues](https://github.com/0disoft/dsh-ci-diet/issues)에 남겨 주세요. 규칙이나 계약을 바꾸려면 먼저 [플러그인 안내](docs/guide/plugin.md)와 [결정 기록](docs/spec/decisions.md)을 읽어 주세요. 상세 사양과 공개 문서는 영어로 작성합니다.

MIT © Rodisoft
