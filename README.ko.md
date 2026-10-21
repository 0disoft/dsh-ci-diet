# CI Diet

낭비된 GitHub Actions 러너 시간을 찾고, 작고 검토 가능한 패치를 제안합니다.

상태: **알파, npm에 `dsh-ci-diet@0.1.1`로 배포됨**. 계약, 명세, 분석 엔진,
패치 엔진, CLI, DSH 플러그인 도구, 자체 완결형 HTML 보고서는 구현과 테스트를
마쳤습니다. DSH Web 클라이언트 화면은 아직 남아 있습니다.

## 하는 일

CI Diet는 두 가지를 읽고 비교합니다.

1. 현재 작업 폴더의 workflow YAML
2. 선택 사항으로, 읽기 전용 `gh api` 호출로 가져온 실행 이력

여기서 러너 시간이 어디에 쓰였는지, 어떤 발견이 안전한 YAML 편집으로 바뀔 수
있는지 보고합니다. 모든 발견에는 근거 수준(`observed`, `inferred`, `static`)과
규칙별 coverage 상태가 붙습니다.

| 규칙 | 찾는 것 | v0.1 패치 |
| --- | --- | --- |
| CD001 | 더 새 커밋에 밀린 PR 실행 | 패치: `concurrency` |
| CD002 | 겹치는 트리거 | 설명만 |
| CD003 | 문서만 바뀐 변경의 무거운 검사 | 설명만 |
| CD004 | 과대한 매트릭스 | 설명만 |
| CD005 | `timeout-minutes` 없는 job | 패치: `timeout-minutes` |
| CD008 | 긴 artifact 보존 기간 | 패치: `retention-days` |

규칙 집합은 일부러 작습니다. 실제 저장소에서 품질 기준을 통과한 규칙만
출시합니다. 잘못 짚는 규칙은 없는 규칙보다 나쁘기 때문입니다. CD003과 CD005는
구현되어 있지만 그 기준을 통과할 때까지 기본으로 꺼져 있습니다(ADR-13 참고).

## 하지 않는 일

- 커밋, 푸시, PR, 병합을 하지 않습니다.
- workflow를 실행하지 않고, 실행 중인 job을 취소하지 않으며, artifact나 캐시를
  삭제하지 않습니다.
- 브랜치 보호 설정을 바꾸지 않습니다.
- GitHub 쓰기 권한이 필요 없습니다. 이력 조회는 읽기 전용이고, 네트워크가 없어도
  정적 스캔은 동작합니다.
- job이 낭비인지 LLM으로 판정하지 않습니다.
- 패치는 이미 가진 YAML의 바이트 범위 편집입니다. diff를 검토하고 직접 승인한 뒤
  작업 폴더에 적용합니다.

## 숫자를 섞지 않습니다

비용 출력은 네 값을 분리해 표시합니다.

| 필드 | 의미 |
| --- | --- |
| `observedRunnerSeconds` | 실행 기록이 실제로 말하는 값 |
| `modeledRoundedMinutes` | 과금처럼 분 단위로 올림한 값 |
| `listPriceUsd` | 스냅샷 정가로 환산한 값 |
| `actualBilledUsd` | 증명할 수 없으므로 항상 `null` |

모든 보고서는 사용한 가격 스냅샷을 해시와 함께 포함하므로 나중에 같은 숫자를
재현할 수 있습니다. 스냅샷을 검증할 수 없으면 보고서를 내보내지 않습니다.

## 설치

```
npm install --global dsh-ci-diet
dsh plugin --profile web add dsh-ci-diet
```

플러그인은 기본으로 꺼진 로더 항목 하나를 추가합니다. 이력 동기화를 쓸 때만
`networkEnabled`를 켜십시오. 전역 설치는 선택 사항입니다. `npx dsh-ci-diet`로
같은 CLI를 실행할 수 있고, DSH 플러그인은 프로필에 패키지가 있으면 됩니다.
릴리스 태그는 GitHub에, 같은 버전은 npm `0.1.1`에 있습니다.

## 실행

```
ci-diet scan --cwd .                     # 네트워크 없는 정적 스캔
ci-diet sync --network                   # 이 체크아웃의 GitHub Actions 이력 조회
ci-diet plan --rule CD001 --workflow .github/workflows/ci.yml \
             --claims ci-only,replace-safe
ci-diet approve --plan <planId> --confirm <digest tail>
ci-diet apply --plan <planId>            # 계획된 바이트 범위만 다시 씀
ci-diet revert --change <changeId>       # 백업한 바이트를 복원
```

`plan`은 발견이 패치 가능하지 않거나, coverage가 쓰기를 허용하지 않거나, 해당
규칙이 의존하는 정책 스냅샷이 오래됐으면 계획을 만들지 않습니다. CD005는
`--job`과 `--minutes`가, CD008은 `--job`과 `--step`, 그리고
`--claims artifact-purpose:temporary,consumer-min-days:7`이 필요합니다. 명시적
`approve` 없이는 아무것도 커밋·푸시·적용되지 않습니다.

## 보고서 읽기

```
ci-diet report                 # 저장된 최신 보고서의 텍스트 요약
ci-diet report --format html --out report.html
ci-diet prune                  # 만료된 보고서, 계획, 캐시 정리
```

HTML 파일은 자체 완결형입니다. 인라인 CSS만 쓰고 스크립트와 외부 요청이 없습니다.
읽기 전용이므로 승인은 digest와 nonce 검사가 있는 CLI에 남습니다.

## 릴리스

`package.json`의 버전과 일치하는 태그를 푸시하면
`.github/workflows/publish.yml`이 실행됩니다.

```
git tag v0.1.1
git push origin v0.1.1
```

워크플로는 태그와 `package.json` 버전을 대조하고(`node
scripts/check-release-tag.mjs`), CI와 같은 검사를 실행한 뒤, 이미 배포된
버전이면 게시를 거부합니다. 통과하면 npm trusted publishing으로 게시합니다.
GitHub OIDC(`id-token: write`)를 쓰고 npm 토큰은 쓰지 않으므로, 패키지의
trusted publisher에 이 저장소의 `publish.yml`이 등록되어 있어야 합니다.

## 요구 사항

- Node `^22.19.0 || >=24.0.0`
- `gh` CLI(선택): 실행 이력 조회에만 사용
- DSH `>=0.2.1-rc.2 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0`(선택): 플러그인 도구에만
  사용

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

테스트는 Node로 실행해 배포 진입점이 Node 호환으로 유지되는지 확인합니다. Bun은
의존성 관리에만 씁니다.

## 구조

```
src/core        workflow 파싱, 규칙, 절감 계산, 패치 엔진
src/adapters    github, git, storage
src/dsh         호스트·클라이언트 플러그인 코드
src/cli         명령줄 진입점
src/shared      i18n과 작은 공용 도구
contracts       설계 팩에서 가져온 JSON Schema
examples        합성 예제와 검산 벡터
docs/spec       규범 제품 명세
scripts         계약·문서 검사 스크립트
tests/unit      네트워크가 필요 없는 빠른 검사
```

## 언어

영어가 기본이며 메시지 키의 단일 소스입니다. CLI, HTML 보고서, DSH 도구 문구는
영어·한국어·중국어 간체·힌디어·스페인어·프랑스어로 제공하며, 모든 사전이 완역이라
키가 빠지면 타입 오류가 납니다. 지역 태그는 언어로 해석하고(`hi-IN`, `es-MX`,
`fr-CA`), 간체가 아닌 중국어 변형은 영어로 대체합니다.

언어 선택 순서는 `--lang`, DSH 언어 설정, `LC_ALL`/`LC_MESSAGES`/`LANG`,
영어입니다. 보고서는 영어로 저장하고 표시할 때만 번역합니다. 규칙 ID, 오류 코드,
열거값, 경로, 다이제스트, 수치는 번역하지 않으며 HTML 보고서의 `lang` 속성은
선택한 언어를 따릅니다. DSH 도구 설명은 플러그인 로드 시점에 고정되므로 DSH
언어 설정을 바꾸면 다시 로드해야 합니다. 공개 문서는 영어이고 README만 한국어로
미러링합니다.

## 문서

- 명세: [docs/spec/README.md](docs/spec/README.md)
- 규칙: [docs/spec/rules.md](docs/spec/rules.md)
- 비용 모델: [docs/spec/cost-model.md](docs/spec/cost-model.md)
- 패치 모델: [docs/spec/patch-model.md](docs/spec/patch-model.md)
- 저장·오류: [docs/spec/storage.md](docs/spec/storage.md)
- 결정 기록: [docs/spec/decisions.md](docs/spec/decisions.md)
- 측정: [docs/spikes/a0a-rules.md](docs/spikes/a0a-rules.md)
- 플러그인·CLI 안내: [docs/guide/plugin.md](docs/guide/plugin.md)
- 계약 출처: [contracts/UPSTREAM.md](contracts/UPSTREAM.md)
- English: [README.md](README.md)

## 라이선스

MIT