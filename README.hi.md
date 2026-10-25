# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

**स्थिति:** alpha; `dsh-ci-diet@0.4.0` npm पर उपलब्ध है। Current source tree में मौजूद contracts, analysis और patch engines, CLI, DSH tools, Settings page और self-contained HTML report के साथ **सेटिंग्स → CI Diet Reports** review screen जोड़ा गया है। Review screen ने पिछले commit में असली browser E2E पास किया था। एक बार होने वाली defaults migration को अलग से DSH `0.2.1-rc.2` के configEditor, SettingsForms और Loader runtime में verify किया गया; यह नए browser render का verification नहीं है। DSH plugin अब preflight, history के लिए network access और local apply के साथ चालू होता है।

**DSH डिफ़ॉल्ट और माइग्रेशन।** नई प्रोफ़ाइल में `preflightEnabled`, `networkEnabled`, `localApplyEnabled` तथा CD001, CD002, CD004, CD006, CD008 सक्षम होते हैं। लॉक की गई प्रोफ़ाइल माइग्रेशन `defaultsRevision: 2` दर्ज करता है। संशोधन 1 में पहले ही माइग्रेट की गई प्रोफ़ाइलें बाद के स्विच और नियम चयन को बनाए रखती हैं। स्टेट पाथ, रिटेंशन, कोटा और मौजूदा संख्यात्मक खाता इनपुट सुरक्षित रहते हैं। CD003 और CD005 सक्षम किए जाने तक बंद रहते हैं। मौद्रिक अनुमान दोनों खाता इनपुट का स्वतः उपयोग करते हैं; खाली होने का अर्थ अज्ञात है और स्पष्ट `0` मान्य है। पहले सक्षम बिलिंग में कोई मान छोड़े जाने पर उसके शून्य डिफ़ॉल्ट बने रहते हैं।

CI Diet संभवतः बर्बाद हो रहे GitHub Actions काम को खोजता है, हर finding के पीछे का evidence सुरक्षित रखता है, और मनुष्य द्वारा समीक्षा के लिए छोटे workflow बदलावों का preview देता है।

**केवल installation से runner minutes कम नहीं होते।** समर्थित DSH deployment commands चलने से पहले बचत के उम्मीदवार अपने आप जाँचते हैं; workflow बदलाव समीक्षा और approval के बाद ही लागू होते हैं। DSH plugin में approval, apply या revert tools नहीं हैं, और preflight खुद files नहीं बदलता। Settings pages tool configuration रखते हैं और host के session-scoped reports और plans दिखाते हैं; वे workflow को optimize नहीं करते। Approved local writes default में चालू हैं, पर apply के लिए अलग digest approval अब भी ज़रूरी है। किसी finding से लागत कम होने की गारंटी नहीं है।

`preflightEnabled` default में चालू है। `workdir` argument वाले समर्थित stateless DSH bash tool में literal `git push`, `npm|pnpm|bun publish`, `wrangler deploy` या `npm|pnpm|bun run deploy` से ठीक पहले offline जाँच होती है। यह npm CD006, केवल-PR workflow में concurrency की कमी, और स्पष्ट download cache के बिना Bun frozen install को समीक्षा के लिए दिखाता है। उम्मीदवार मिलने पर पहली command नहीं चलती; model items देखकर वही command फिर चलाए तो अनुमति मिलती है। preflight खुद कोई network request या automatic file change नहीं करता, और plan apply के लिए मानव approval अभी भी ज़रूरी है। persistent shells और जटिल shell wrappers पहचाने नहीं जाते, इसलिए preflight उन्हें skip करता है। बचत अभी मापी नहीं गई है, इसलिए बचत का दावा नहीं है।

## यह क्या करता है

Static scan लक्षित checkout के workflow YAML को पढ़ता है। वैकल्पिक history sync read-only `gh api` calls से हाल के runs इकट्ठा करता है। हर finding पर evidence level (`observed`, `inferred` या `static`) और हर axis का collection coverage होता है।

| Rule | क्या मिलता है | संभावित plan |
| --- | --- | --- |
| CD001 | नए commit से अप्रचलित PR runs | `concurrency` बदलाव |
| CD002 | Overlapping triggers | केवल explanation |
| CD003 | केवल docs बदलने पर भारी checks | केवल explanation; default में बंद |
| CD004 | बहुत बड़ी matrices | केवल explanation |
| CD005 | `timeout-minutes` रहित jobs | timeout बदलाव; default में बंद |
| CD006 | npm / pnpm / Bun | [CD006](docs/spec/rules.md) |
| CD008 | लंबी artifact retention | retention बदलाव |

CD001 नए commit से superseded होकर overlap करते PR runs में मदद करता है। CD005 असामान्य runs पर सीमा लगाता है; सामान्य job runtime कम नहीं करता। CD008 artifact storage retention बदलता है, runner minutes नहीं। CD003 और CD005 अपने quality gates पास होने तक बंद रहते हैं।

CD006 सत्यापित npm/pnpm सेटअप और ऐसे Bun जॉब्स का भी समर्थन करता है जो `oven-sh/setup-bun@v2` का उपयोग करते हैं और उसके बाद ट्रैक किए गए टेक्स्ट `bun.lock` के साथ `bun install --frozen-lockfile` चलाते हैं। Bun एक डाउनलोड-कैश चरण जोड़ता है; इंस्टॉलेशन और टेस्ट अब भी चलते हैं। कैश को बहाल करने/सहेजने का ओवरहेड लाभ से अधिक हो सकता है। [वर्तमान कैश गार्ड](docs/spec/rules.md#bun-dependency-cache-variant) और [एक मापा गया उदाहरण](docs/measurements/2026-10-25-cache-review.md) देखें। नीचे दिया गया npm उदाहरण समर्थित रूपों में से एक को दर्शाता है।

## Install और upgrade

CLI के लिए Node `^22.19.0 || >=24.0.0` चाहिए। Plugin DSH `>=0.2.1-rc.2 <0.3.0-0` और `>=0.2.2-rc.1 <0.3.0-0` का समर्थन करता है। Version `0.3.1` को DSH `0.2.1-rc.2` पर जाँचा गया; DSH `0.3.0` समर्थित नहीं है।

```
npm install --global dsh-ci-diet@0.4.0
ci-diet --version
```

Global install न चाहें तो command नाम `ci-diet` की जगह `npx dsh-ci-diet@0.4.0` रखें, उदाहरण `npx dsh-ci-diet@0.4.0 report --cwd .`।

```
dsh plugin --profile web add dsh-ci-diet@0.4.0
dsh --profile web
```

Install करने से plugin tools, Settings page और **सेटिंग्स → CI Diet Reports** review screen register होते हैं। Plugin का preflight, network access और local apply default में चालू हैं। Install और startup `gh` call, history collection, scan या workflow change नहीं करते।

```
npm install --global dsh-ci-diet@latest
dsh plugin --profile web add dsh-ci-diet@latest
```

Plugin update के बाद DSH restart करें। `dsh plugin --profile web list`, `ci-diet --version` या `npx dsh-ci-diet@latest --version` से installed versions जाँचें।

## पहला scan और history report

ये commands उस repository में चलाएँ जिसकी जाँच करनी है। `--cwd .` उसी repository को दर्शाता है; `--cwd` कोई दूसरा path भी ले सकता है और relative paths effective working directory से resolve होते हैं। पहला command offline चलता है। History collection के लिए network अलग और स्पष्ट रूप से enable करना होता है।

```
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`scan` network के बिना static report output करता है; `--json` या `--out FILE` वह output लिख सकते हैं, लेकिन CLI scan report को state store में save नहीं करता। `report` को CLI `sync`, plugin `ci_diet_scan` या plugin `ci_diet_sync` द्वारा saved report चाहिए। नीचे के केवल-CLI क्रम में sync report save करता है; फिर HTML विकल्प एक self-contained file लिखता है। History sync के लिए `gh` install और authenticated होना चाहिए तथा repository के Actions runs और jobs पढ़ने की अनुमति चाहिए। `sync --network` CLI की स्पष्ट opt-in है। GitHub write permission नहीं चाहिए। अधूरी history पर भी report बनती और save होती है, साथ में incomplete coverage दिखती है। Plugin का offline `ci_diet_scan` report save करता है, इसलिए उसके ठीक बाद `ci_diet_report` चल सकता है।

DSH plugin में network access default में चालू है, इसलिए `gh` install और authenticate होने पर `ci_diet_sync` सीधे चल सकता है। यह switch केवल उस tool को `gh` call करने देता है; install, startup या settings save खुद history collect नहीं करते। Plugin का network उपयोग रोकने के लिए **सेटिंग्स → CI Diet** में **नेटवर्क पहुँच की अनुमति दें** बंद करें और **बदलाव सहेजें** चुनें। यह page setting केवल plugin tools पर लागू होती है; CLI का `--network` flag enable नहीं करती। Static scan और report network के बिना चलते हैं। Settings page अपने आप optimization नहीं चलाता।

अच्छे chat request में क्रम और review सीमा साफ़ लिखें। उदाहरण absolute path की जगह अपनी repository का path रखें:

> cwd `C:\work\my-repo` के साथ `ci_diet_scan`, फिर उसी cwd के लिए `ci_diet_sync` और `ci_diet_report` चलाओ। अगर `gh` authenticate नहीं है या मैंने network access बंद किया है तो scan के बाद रुक जाओ। अगर `ci_diet_plan` से patch preview हो तो केवल edits दिखाओ। कुछ भी approve, apply, revert, commit, push या deploy मत करो।

Plugin preview plan को save नहीं करता। उसका `nextCommand` CLI के ज़रिए plan फिर बनाता है ताकि plan durable store में जाए और human approval चरण में आ सके।

## Offline npm cache plan (CD006)

CD006 को run history की ज़रूरत नहीं है। यह repository root के job से मिलता है जहाँ `actions/checkout` में उपयोगकर्ता के `with` विकल्प नहीं हैं, ठीक उसके बाद cache रहित एक `actions/setup-node@v3` या `@v4` step है, और अगले step का `run` ठीक `npm ci` है। root के `package.json` और `package-lock.json` committed सामान्य JSON files होने चाहिए। plan setup-node में केवल `cache: npm` और `cache-dependency-path: package-lock.json` जोड़ता है; Node, action versions, `npm ci`, tests या local caching नहीं बदलता।

```
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
```

`--step` setup-node step का शून्य से शुरू होने वाला index है; उदाहरण में checkout 0 और setup-node 1 है। CLI `plan` यह static scan memory में चलाकर `sync` के बिना plan सहेजता है और नवीनतम saved report को वैसा ही रखता है। plugin `ci_diet_plan` को saved report चाहिए, इसलिए पहले `ci_diet_scan` चलाएँ। approval और apply के लिए नीचे के मौजूदा commands इस्तेमाल करें। plan और attestation planning के दौरान सहेजे जाते हैं; किसी व्यक्ति के plan approve करने और apply चलाने से पहले कोई workflow file नहीं बदलती।

## CLI command reference

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

`scan` workflow files जाँचता है। `sync` केवल `--network` के साथ history पढ़ता है; `--repo` से `OWNER/REPO` स्पष्ट चुनें और `--days` से configured सीमा में lookback बदलें। `report` text, JSON या HTML देता है और `--out` को `--cwd` के सापेक्ष लिखता है। `diagnose` stored history से job-name matching और coverage समझाता है; `--require-complete` जोड़ने पर अधूरे data के लिए exit code `3` मिलता है। `prune` state-store settings के अनुसार expired reports, plans और cache entries हटाता है। `changes` applied changes दिखाता है और `plans` saved plan फिर खोलता है। `--config FILE` किसी भी command में partial JSON configuration merge करता है।

## Review, approve, apply और revert

सफल CLI `plan` प्रस्तावित diff, `p_...` जैसा वास्तविक plan id और plan digest के अंतिम 12 characters से बना confirmation दिखाता है। Plan बनाते समय stale evidence और अन्य unsafe writes अस्वीकार होते हैं; workflow न मिलने पर usage error और exit `1` हो सकता है। Saved plan को बाद में देखते समय workspace या workflow गायब हो तो `plans --plan` diff छिपाता है, plan JSON रखता है, replan माँगता है और exit `3` देता है। Workflow bytes saved source hash से मेल न खाएँ तो भी ऐसा ही होता है। Approve करने से पहले diff और plan फिर जाँचें।

```
ci-diet plan --cwd . --rule CD001 --workflow .github/workflows/ci.yml --claims ci-only,replace-safe
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet revert --cwd . --change CHANGE_ID
```

`PLAN_ID` की जगह plan का दिखाया id, `CONFIRMATION` की जगह digest के अंतिम 12 characters और `CHANGE_ID` की जगह apply का दिखाया id लगाएँ। सभी values literal arguments हैं; angle brackets न लिखें। `approve` single-use approval बनाता है, `apply` केवल एक workflow file की planned byte range बदलता है और `revert` उस change का backup बहाल करता है। परिणामी diff देखें और ज़रूरत के अनुसार repository checks चलाएँ। CI Diet commit, push, deploy, workflow run, branch protection बदलाव या artifact deletion नहीं करता।

केवल PR CI के योग्य CD001 उदाहरण में `ci-only` और `replace-safe` human attestations हैं। ये बताते हैं कि operator ने cancellation semantics की समीक्षा की; ये bypass switches नहीं हैं। CD005 को measured `--job` और `--minutes` चाहिए, और CD008 को `--job`, target step का शून्य से शुरू होने वाला numeric `--step` array index और artifact claims चाहिए। CD006 को `--job` और setup-node/setup-bun step का शून्य से शुरू होने वाला `--step` index चाहिए; इसमें claims नहीं हैं। दोनों step नियमों में numeric step array index है, step name token नहीं।

## State और सीमाएँ

CLI और plugin डिफ़ॉल्ट state directory साझा करते हैं: Windows पर `%LOCALAPPDATA%\CI-Diet\profiles\default`, अन्यथा `~/.local/state/ci-diet/profiles/default`। Plugin का `stateDir` override अलग store बनाता है; CLI के `plan`, `approve`, `apply` और `revert` में `--state-dir` से वही absolute path दें। CLI का relative `--state-dir` effective `--cwd` के सापेक्ष resolve होता है। मौजूदा state दूसरे directory में अपने आप migrate नहीं होता।

Web client में Settings और **CI Diet Reports** review screen हैं। Report, approve, apply और revert controls ने पिछले commit में असली browser E2E पास किया था। Defaults migration को DSH `0.2.1-rc.2` runtime में configEditor, SettingsForms, Loader और temporary profile के साथ अलग से verify किया गया: legacy `false` मान `true` के रूप में save हुए, और बाद में स्पष्ट रूप से save किया गया `false` restart के बाद भी बंद रहा। यह नया browser render verification नहीं है। Approval और apply इसी screen से host तक जाते हैं, और `localApplyEnabled` default में चालू है। कोई plugin tool approval या application नहीं करता। Plan एक मौजूदा workflow file को byte ranges पर बदलता है और unsupported structures अस्वीकार करता है। History या workflow attribution अधूरा हो तो findings गलत या छूटे हो सकते हैं, और किसी दूसरे system के billing data ज़्यादा सही हो सकते हैं। Report को review evidence मानें और effect GitHub में अलग से जाँचें।

## Cost और evidence

| Field | अर्थ |
| --- | --- |
| `observedRunnerSeconds` | Collected runs में recorded runner time |
| `modeledRoundedMinutes` | Modeling के लिए प्रति job ऊपर की ओर rounded minutes |
| `listPriceUsd` | Report में embedded list-price snapshot पर cost |
| `actualBilledUsd` | Actual bill सिद्ध होने तक हमेशा `null` |

Reports pricing snapshot और content hash रखती हैं ताकि numbers फिर reproduce हो सकें। ये automatic savings का दावा नहीं करतीं। HTML report में inline CSS है, कोई script या external request नहीं है।

## Languages

DSH Settings UI, CLI messages, HTML reports और ये छह READMEs English, Korean, Simplified Chinese, Hindi, Spanish और French का समर्थन करते हैं। Detailed specifications केवल English में हैं। Selection order `--lang`, DSH locale, `LC_ALL`/`LC_MESSAGES`/`LANG`, फिर English है। CLI language codes `en`, `ko`, `zh-Hans`, `hi`, `es`, `fr` हैं; example command का `ko` अपनी पसंद का code रखें। Regional tags language से resolve होते हैं। Reports English में save और display पर localize होती हैं। Rule ids, error codes, enum values, paths, hashes और numbers literal रहते हैं। HTML का `lang` attribute selected locale का अनुसरण करता है। DSH tool descriptions plugin load पर capture होते हैं, इसलिए DSH language preference बदलने के बाद reload करें।

## Development

```
bun install
node scripts/test-core.mjs
node scripts/gen-types.mjs --check
node scripts/sync-contracts.mjs --check
bun run typecheck
bun run lint
bun run test:docs
```

Published entry points को Node-compatible रखने के लिए tests Node से चलाएँ। Bun केवल dependency management के लिए है।

## Release

`package.json` से मेल खाता tag push करने पर `.github/workflows/publish.yml` शुरू होता है। नीचे दोनों arguments में literal `VERSION` की जगह नया version रखें; `0.3.1` पहले ही publish है, इसलिए वह tag फिर न बनाएँ।

```
git tag vVERSION
git push origin vVERSION
```

Workflow tag और `package.json` की तुलना करता है, release checks चलाता है, मौजूद npm version अस्वीकार करता है, और GitHub OIDC के ज़रिए npm trusted publishing से publish करता है। Trusted publisher में `publish.yml` नाम होना चाहिए।

## Layout

```
src/core        workflow parsing, rules, savings, patch engine
src/adapters    GitHub, git, storage
src/client      Web Settings and review UI
src/dsh         host plugin and bundle code
src/cli         command-line entry
src/shared      i18n and shared helpers
contracts       JSON Schemas from the frozen design pack
examples        sample records and evaluation vectors
docs/spec       normative specification
scripts         contract and documentation checks
tests/unit      fast checks that need no network
```

## Documentation

Detailed specification, rule, cost, patch, storage और decision documents **English** में हैं। Specification index [docs/spec/README.md](docs/spec/README.md) है। यह भी देखें: [rules](docs/spec/rules.md), [cost model](docs/spec/cost-model.md), [patch model](docs/spec/patch-model.md), [storage and errors](docs/spec/storage.md), [decisions](docs/spec/decisions.md), [measurement](docs/spikes/a0a-rules.md), [plugin and CLI guide](docs/guide/plugin.md), और [contract provenance](contracts/UPSTREAM.md)।

## License

MIT
