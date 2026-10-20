# CI Diet

낭비된 GitHub Actions 러너 시간을 찾고, 작고 검토 가능한 패치를 제안합니다.

상태: **설계 단계**. 계약과 명세는 이 저장소에 있지만 분석 엔진, 패치 엔진,
CLI, DSH Web 플러그인은 아직 구현되지 않았으므로 설치할 것이 없습니다.

## 앞으로 할 일

CI Diet는 두 가지를 읽고 비교합니다.

1. 현재 작업 폴더의 workflow YAML
2. 선택 사항으로, 읽기 전용 `gh api` 호출로 가져온 실행 이력

여기서 러너 시간이 어디에 쓰였는지, 어떤 발견이 안전한 YAML 편집으로 바뀔 수
있는지 보고합니다. 모든 발견에는 근거 수준(`observed`, `inferred`, `static`)과
규칙별 coverage 상태가 붙습니다.

| 규칙 | 찾는 것 | v0.1 계획 |
| --- | --- | --- |
| CD001 | 더 새 커밋에 밀린 PR 실행 | 패치: `concurrency` |
| CD002 | 겹치는 트리거 | 설명만 |
| CD003 | 문서만 바뀐 변경의 무거운 검사 | 설명만 |
| CD004 | 과대한 매트릭스 | 설명만 |
| CD005 | `timeout-minutes` 없는 job | 패치: `timeout-minutes` |
| CD008 | 긴 artifact 보존 기간 | 패치: `retention-days` |

규칙 집합은 일부러 작습니다. 실제 저장소에서 품질 기준을 통과한 규칙만
출시합니다. 잘못 짚는 규칙은 없는 규칙보다 나쁘기 때문입니다. CD003과
CD005는 구현되어 있지만 그 기준을 통과할 때까지 기본으로 꺼져 있습니다
(ADR-13 참고).

## 하지 않는 일

- 커밋, 푸시, PR, 병합을 하지 않습니다.
- workflow를 실행하지 않고, 실행 중인 job을 취소하지 않으며, artifact나
  캐시를 삭제하지 않습니다.
- 브랜치 보호 설정을 바꾸지 않습니다.
- GitHub 쓰기 권한이 필요 없습니다. 이력 조회는 읽기 전용이고, 네트워크가
  없어도 정적 스캔은 동작합니다.
- job이 낭비인지 LLM으로 판정하지 않습니다.
- 패치는 이미 가진 YAML의 바이트 범위 편집입니다. diff를 검토하고 직접
  승인한 뒤 작업 폴더에 적용합니다.

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

## 요구 사항

- Node `^22.19.0 || >=24.0.0`
- `gh` CLI(선택): 실행 이력 조회에만 사용
- DeepSeek Harness Web(선택): 플러그인 UI에만 사용

## 개발

```
bun install
node --test "tests/unit/*.test.ts"
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

영어가 기본이며 메시지 키의 단일 소스입니다. 한국어는 전체 번역되어 있고,
중국어 간체는 번역 슬롯으로만 두며 관리자가 생기기 전까지 영어로 대체됩니다.
공개 문서는 영어이고 README만 한국어로 미러링합니다.

## 문서

- 명세: [docs/spec/README.md](docs/spec/README.md)
- 규칙: [docs/spec/rules.md](docs/spec/rules.md)
- 비용 모델: [docs/spec/cost-model.md](docs/spec/cost-model.md)
- 패치 모델: [docs/spec/patch-model.md](docs/spec/patch-model.md)
- 저장·오류: [docs/spec/storage.md](docs/spec/storage.md)
- 결정 기록: [docs/spec/decisions.md](docs/spec/decisions.md)
- 플러그인·CLI 안내: [docs/guide/plugin.md](docs/guide/plugin.md)
- 계약 출처: [contracts/UPSTREAM.md](contracts/UPSTREAM.md)
- English: [README.md](README.md)

## 라이선스

MIT