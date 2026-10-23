# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

**상태:** 알파. `dsh-ci-diet@0.3.1`이 npm에 게시되어 있습니다. 계약, 분석·패치 엔진, CLI, DSH 도구, 설정 화면, 자체 완결형 HTML 보고서는 구현했습니다. 보고서·적용 화면은 아직 없습니다.

CI Diet는 낭비 가능성이 있는 GitHub Actions 작업을 찾고, 각 발견의 근거를 보존하며, 사람이 검토할 작은 workflow 수정을 미리 보여줍니다.

**설치만으로는 러너 시간이 줄지 않습니다.** 패키지를 설치하거나 LLM에게 코드 작성·배포를 요청하는 것만으로는 도구가 호출되거나 workflow가 바뀌지 않습니다. scan, sync, report, prune, plan을 직접 요청하고 제안된 변경을 검토해야 합니다. DSH 플러그인에는 자동 pre-push·배포 훅이 없고 승인·적용·되돌리기 도구도 없습니다. 설정 화면은 도구 설정을 저장할 뿐 workflow를 최적화하지 않습니다. 어떤 발견도 비용 절감을 보장하지 않습니다.

## 하는 일

정적 스캔은 대상 체크아웃의 workflow YAML을 읽습니다. 선택적인 이력 동기화는 읽기 전용 `gh api` 호출로 최근 실행을 모읍니다. 발견에는 근거 수준(`observed`, `inferred`, `static`)과 축별 수집 coverage가 붙습니다.

| 규칙 | 찾는 것 | 가능한 plan |
| --- | --- | --- |
| CD001 | 더 새 커밋 때문에 무효가 된 PR 실행 | `concurrency` 편집 |
| CD002 | 겹치는 트리거 | 설명만 |
| CD003 | 문서만 바뀐 변경의 무거운 검사 | 설명만, 기본 꺼짐 |
| CD004 | 과대한 매트릭스 | 설명만 |
| CD005 | `timeout-minutes`가 없는 job | timeout 편집, 기본 꺼짐 |
| CD008 | 긴 artifact 보존 기간 | 보존 기간 편집 |

CD001은 겹쳐서 대체된 PR 실행에 도움을 줍니다. CD005는 비정상 실행의 상한을 두는 규칙이며 정상 job 실행 시간 자체를 줄이지 않습니다. CD008은 artifact 저장 보존 기간을 바꾸며 러너 분과는 관계가 없습니다. CD003과 CD005는 품질 기준을 통과할 때까지 기본으로 꺼져 있습니다. 캐시 위생은 점검용 진단으로만 나옵니다. 동결된 계약에 캐시 규칙 ID가 없으므로 캐시 힌트는 발견이나 패치가 되지 않습니다.

## 설치와 업그레이드

CLI에는 Node `^22.19.0 || >=24.0.0`이 필요합니다. 플러그인은 DSH `>=0.2.1-rc.2 <0.3.0-0` 및 `>=0.2.2-rc.1 <0.3.0-0`을 지원합니다. `0.3.1`은 DSH `0.2.1-rc.2`에서 검증했고 DSH `0.3.0`은 지원하지 않습니다.

```
npm install --global dsh-ci-diet@0.3.1
ci-diet --version
```

전역 설치를 원하지 않으면 `ci-diet` 명령 이름 자리에 `npx dsh-ci-diet@0.3.1`을 넣습니다. 예를 들어 `npx dsh-ci-diet@0.3.1 report --cwd .`처럼 실행합니다.

```
dsh plugin --profile web add dsh-ci-diet@0.3.1
dsh --profile web
```

설치하면 플러그인 도구와 설정 화면이 등록됩니다. 네트워크 접근은 기본으로 꺼져 있고, DSH를 시작한다고 해서 스캔을 실행하거나 workflow를 수정하지 않습니다.

```
npm install --global dsh-ci-diet@latest
dsh plugin --profile web add dsh-ci-diet@latest
```

플러그인을 업데이트한 뒤 DSH를 재시작합니다. `dsh plugin --profile web list`, `ci-diet --version`, `npx dsh-ci-diet@latest --version`으로 설치 버전을 확인합니다.

## 첫 스캔과 이력 보고서

검사할 저장소에서 명령을 실행합니다. `--cwd .`는 그 저장소를 뜻하고, `--cwd`에는 다른 경로도 줄 수 있습니다. 상대 경로는 적용된 작업 디렉터리 기준으로 해석됩니다. 첫 명령은 오프라인입니다. 이력 수집은 별도로 명시적으로 네트워크를 허용해야 합니다.

```
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`scan`은 네트워크 없이 정적 보고서를 출력합니다. `--json`이나 `--out FILE`로 그 출력을 쓸 수 있지만 CLI scan은 상태 저장소에 보고서를 저장하지 않습니다. `report`에는 CLI `sync`, 플러그인의 `ci_diet_scan` 또는 `ci_diet_sync`가 저장한 보고서가 필요합니다. 아래 CLI 전용 순서에서는 sync가 보고서를 저장한 뒤 HTML 옵션으로 외부 요청이 없는 파일 하나를 만듭니다. 이력 동기화에는 `gh`가 설치·인증되어 있고 저장소의 Actions 실행과 job을 읽을 권한이 있어야 합니다. `sync --network`는 CLI의 명시적 네트워크 허용입니다. GitHub 쓰기 권한은 필요하지 않습니다. 이력이 일부만 수집돼도 보고서를 만들고 저장하며 coverage가 불완전하다고 표시합니다. 플러그인의 오프라인 `ci_diet_scan`은 보고서를 저장하므로 바로 `ci_diet_report`를 실행할 수 있습니다.

DSH 플러그인의 네트워크 접근은 기본으로 꺼져 있습니다. **설정 → CI Diet**에서 **네트워크 접근 허용**을 켜고 **변경 저장**을 누릅니다. 이 설정은 플러그인 도구에 적용되며 CLI의 `--network` 플래그를 켜지는 않습니다. 정적 스캔과 보고서는 네트워크 없이 동작합니다. 허용한 뒤 `ci_diet_sync`는 읽기 권한이 있는 인증된 `gh`를 사용합니다. 설정 화면 자체가 최적화를 실행하지는 않습니다.

좋은 채팅 요청에는 실행 순서와 검토 경계를 분명히 적습니다. 절대 경로 예시는 자신의 저장소 경로로 바꿉니다.

> `C:\work\my-repo`를 cwd로 `ci_diet_scan`을 실행해 줘. 내가 설정 → CI Diet에서 네트워크 접근 허용을 켠 뒤 같은 cwd로 `ci_diet_sync`, 이어서 `ci_diet_report`를 실행해 줘. `ci_diet_plan`으로 패치를 미리 볼 때는 편집 내용만 보여 줘. 승인, 적용, 되돌리기, 커밋, 푸시, 배포는 하지 마.

플러그인 미리보기는 plan을 저장하지 않습니다. 응답의 `nextCommand`는 plan을 CLI로 다시 만들어 같은 상태 저장소에 보관하고 사람의 승인 단계로 넘깁니다.

## CLI 명령 참고

```
ci-diet scan --cwd .
ci-diet sync --cwd . --network
ci-diet sync --cwd . --network --repo OWNER/REPO --days 7
ci-diet report --cwd .
ci-diet report --cwd . --format json
ci-diet report --cwd . --format html --out report.html
ci-diet diagnose --cwd .
ci-diet prune
ci-diet changes --cwd .
ci-diet plans --cwd . --plan PLAN_ID
ci-diet report --cwd . --lang ko
```

`scan`은 workflow 파일을 검사합니다. `sync`는 `--network`가 있을 때만 이력을 읽으며, `--repo`로 `OWNER/REPO`를 직접 고르고 `--days`로 설정 범위 안에서 조회 기간을 조정합니다. `report`는 텍스트, JSON, HTML을 출력하고 `--out`은 `--cwd` 기준 상대 경로에 씁니다. `diagnose`는 저장된 이력으로 job 이름 매칭과 coverage를 설명하며, `--require-complete`를 붙이면 데이터가 불완전할 때 종료 코드 `3`으로 끝납니다. `prune`은 상태 저장소 설정에 따라 만료된 보고서, plan, 캐시 항목을 지웁니다. `changes`는 적용한 변경을, `plans`는 저장된 plan을 다시 보여줍니다. `--config FILE`은 모든 명령에 부분 JSON 설정을 병합합니다.

## 검토, 승인, 적용, 되돌리기

성공한 CLI `plan`은 제안 diff, `p_...` 같은 실제 plan id, plan digest 마지막 12자를 이용한 confirmation을 보여줍니다. plan 생성 단계에서는 오래된 근거와 안전하지 않은 쓰기를 거부하며, workflow가 없으면 사용법 오류와 종료 코드 `1`로 끝날 수 있습니다. 저장한 plan을 보는 `plans --plan` 실행 시 작업 공간이나 workflow가 사라졌으면 diff를 숨기고 plan JSON은 보존한 채 다시 plan을 만들라고 안내하며 종료 코드 `3`으로 끝납니다. workflow 바이트가 저장된 원본 해시와 달라도 같습니다. 승인 전에 diff와 plan을 다시 확인합니다.

```
ci-diet plan --cwd . --rule CD001 --workflow .github/workflows/ci.yml --claims ci-only,replace-safe
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet revert --cwd . --change CHANGE_ID
```

`PLAN_ID`에는 plan이 출력한 id, `CONFIRMATION`에는 digest 마지막 12자, `CHANGE_ID`에는 apply가 출력한 id를 넣습니다. 모든 값은 그대로 바꿔 넣는 인자이며 꺾쇠괄호를 직접 입력하지 않습니다. `approve`는 1회용 승인을 만들고, `apply`는 workflow 파일 하나의 계획된 바이트 범위만 고치며, `revert`는 그 변경의 백업을 복원합니다. 결과 diff를 검토하고 필요하면 저장소 검사를 실행합니다. CI Diet는 커밋, 푸시, 배포, workflow 실행, 브랜치 보호 변경, artifact 삭제를 하지 않습니다.

대상이 PR 전용 CI인 CD001 예시의 `ci-only`와 `replace-safe`는 사람의 attestation입니다. 취소 의미를 운영자가 검토했다는 진술이며 우회 스위치가 아닙니다. CD005에는 측정된 `--job`과 `--minutes`가 필요하고, CD008에는 `--job`, 대상 step의 0부터 시작하는 숫자 `--step` 배열 인덱스, artifact claims가 필요합니다. 숫자 step은 `upload` 같은 step 이름 토큰이 아닙니다.

## 상태와 한계

CLI와 플러그인은 기본 상태 저장 경로를 공유합니다. Windows에서는 `%LOCALAPPDATA%\CI-Diet\profiles\default`, 그 밖에서는 `~/.local/state/ci-diet/profiles/default`입니다. 플러그인의 `stateDir`를 바꾸면 별도 저장소가 되므로 `plan`, `approve`, `apply`, `revert`마다 CLI에 같은 절대 경로를 `--state-dir`로 전달합니다. CLI의 상대 `--state-dir`는 적용된 `--cwd` 기준으로 해석됩니다. 기존 상태를 다른 디렉터리로 자동 이전하지 않습니다.

Web 클라이언트에는 설정 화면만 있습니다. 보고서·승인·적용·되돌리기 화면은 없고, 승인이나 적용을 하는 플러그인 도구도 없습니다. plan은 기존 workflow 파일 하나를 바이트 범위로 수정하며 지원하지 않는 구조는 거부합니다. 이력이나 workflow 매칭이 일부만 수집되면 발견이 틀리거나 빠질 수 있고, 실제 청구 정보는 다른 시스템이 더 정확할 수 있습니다. 보고서를 검토 근거로 쓰고 GitHub에서 효과를 따로 확인합니다.

## 비용과 근거

| 필드 | 의미 |
| --- | --- |
| `observedRunnerSeconds` | 수집한 실행에 기록된 러너 시간 |
| `modeledRoundedMinutes` | 모델링을 위해 job별로 올림한 분 |
| `listPriceUsd` | 보고서에 넣은 정가 스냅샷 기준 비용 |
| `actualBilledUsd` | 실제 청구를 증명할 수 있을 때까지 항상 `null` |

보고서에는 가격 스냅샷과 콘텐츠 해시를 넣어 숫자를 다시 재현할 수 있게 합니다. 자동 절감을 주장하지 않습니다. HTML 보고서는 인라인 CSS만 쓰며 스크립트와 외부 요청이 없습니다.

## 언어

DSH 설정 UI, CLI 메시지, HTML 보고서, 이 여섯 README는 영어, 한국어, 중국어 간체, 힌디어, 스페인어, 프랑스어를 지원합니다. 상세 명세는 영어로만 제공합니다. 선택 순서는 `--lang`, DSH locale, `LC_ALL`/`LC_MESSAGES`/`LANG`, 영어입니다. CLI 언어 코드는 `en`, `ko`, `zh-Hans`, `hi`, `es`, `fr`이며 예시 명령의 `ko`를 원하는 코드로 바꿉니다. 지역 태그는 언어로 해석합니다. 보고서는 영어로 저장하고 표시할 때 번역합니다. 규칙 ID, 오류 코드, 열거값, 경로, 해시, 숫자는 그대로 둡니다. HTML의 `lang` 속성은 선택한 locale을 따릅니다. DSH 도구 설명은 플러그인을 로드할 때 고정되므로 DSH 언어 설정을 바꾼 뒤 다시 로드합니다.

## 개발

```
bun install
node scripts/test-core.mjs
node scripts/gen-types.mjs --check
node scripts/sync-contracts.mjs --check
bun run typecheck
bun run lint
bun run test:docs
```

게시 진입점의 Node 호환성을 유지하기 위해 테스트는 Node로 실행합니다. Bun은 의존성 관리에 사용합니다.

## 릴리스

`package.json`과 맞는 태그를 푸시하면 `.github/workflows/publish.yml`이 시작됩니다. 아래 두 인자의 `VERSION`을 새 버전으로 바꿉니다. `0.3.1`은 이미 게시되었으므로 그 태그를 다시 만들지 않습니다.

```
git tag vVERSION
git push origin vVERSION
```

워크플로는 태그와 `package.json`을 대조하고 릴리스 검사를 실행합니다. 이미 존재하는 npm 버전은 거부하며 GitHub OIDC 기반 npm trusted publishing으로 게시합니다. trusted publisher에는 `publish.yml`을 등록해야 합니다.

## 구조

```
src/core        workflow parsing, rules, savings, patch engine
src/adapters    GitHub, git, storage
src/client      Web Settings UI
src/dsh         host plugin and bundle code
src/cli         command-line entry
src/shared      i18n and shared helpers
contracts       JSON Schemas from the frozen design pack
examples        sample records and evaluation vectors
docs/spec       normative specification
scripts         contract and documentation checks
tests/unit      fast checks that need no network
```

## 문서

상세 명세, 규칙, 비용, 패치, 저장, 결정 문서는 **영어**로 작성되어 있습니다. 명세 색인은 [docs/spec/README.md](docs/spec/README.md)입니다. [규칙](docs/spec/rules.md), [비용 모델](docs/spec/cost-model.md), [패치 모델](docs/spec/patch-model.md), [저장·오류](docs/spec/storage.md), [결정](docs/spec/decisions.md), [측정](docs/spikes/a0a-rules.md), [플러그인·CLI 안내](docs/guide/plugin.md), [계약 출처](contracts/UPSTREAM.md)도 볼 수 있습니다.

## 라이선스

MIT
