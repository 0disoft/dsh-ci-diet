<p align="center"><img src="docs/assets/readme-banner.svg" alt="CI Diet" width="820"></p>

# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ci-diet"><img src="https://img.shields.io/npm/v/dsh-ci-diet.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <a href="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml"><img src="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

**संभावित रूप से बर्बाद हो रहे GitHub Actions runner समय को पहचानें, सबूत साथ रखें और छोटे सुधारों को मानवीय समीक्षा के लिए योजनाओं में बदलें।**

CI Diet alpha चरण का CLI और DeepSeek Harness (DSH) plugin है। यह workflow definitions पढ़ता है और सक्षम होने पर GitHub Actions history भी; फिर findings दिखाता है और workflow खुद बदले बिना सीमित YAML edits तैयार करता है।

## Install

CLI के लिए Node `^22.19.0 || >=24.0.0` चाहिए। यह npm का मौजूदा release, `0.5.2` है।

```bash
npm install --global dsh-ci-diet@0.5.2
ci-diet --version
dsh plugin --profile web add dsh-ci-diet@0.5.2
dsh --profile web
```

Plugin DSH tools और **Settings → CI Diet** तथा **CI Diet समीक्षा** screens register करता है। केवल install करने से repository scan नहीं होता, runner minutes नहीं बचते और workflow नहीं बदलता। अगर global CLI install नहीं करना है, तो `ci-diet` की जगह `npx dsh-ci-diet@0.5.2` इस्तेमाल करें।

## पहला scan और history

जिस repository को जाँचना है उसी में ये commands चलाएँ। Static scan offline चलता है और report save करता है। History sync एक अलग network step है जो authenticated `gh` CLI से read-only GitHub API requests द्वारा हाल के runs और jobs पढ़ता है।

```bash
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`gh` को repository के Actions runs और jobs पढ़ने की अनुमति चाहिए। CI Diet को GitHub write access कभी नहीं चाहिए। HTML report एक self-contained file है जिसमें inline CSS है, scripts नहीं हैं और बाहरी requests नहीं होतीं। DSH में `ci_diet_scan` और `ci_diet_sync` दोनों report save करते हैं; नए plugin profiles में network access और preflight डिफ़ॉल्ट रूप से चालू हैं।

![CI Diet flow: scan, preview, human approval, apply, measure](docs/assets/workflow.svg)

## यह क्या ढूँढता है

<p align="center">
  <img src="docs/assets/settings-preview.png" alt="कोरियाई UI में default-on preflight वाला CI Diet configuration page" width="560">
</p>
<p align="center"><sub>Settings → CI Diet configuration. कोरियाई UI दिखाया गया है; preflight डिफ़ॉल्ट रूप से चालू है।</sub></p>

| नियम | डिफ़ॉल्ट | क्या ढूँढता है | सामान्य output |
| --- | --- | --- | --- |
| CD001 | चालू | नए commit से अप्रचलित PR runs | `concurrency` plan |
| CD002 | चालू | overlapping या duplicate trigger candidates | explanation |
| CD003 | बंद | declared docs-only changes पर heavy checks | explanation |
| CD004 | चालू | large, resolvable matrices | review note |
| CD005 | बंद | timeout के बिना jobs | measured `timeout-minutes` plan |
| CD006 | चालू | explicit cache के बिना supported npm, pnpm या Bun frozen-install jobs | download-cache plan |
| CD008 | चालू | ज़रूरत से लंबे artifact retention | human attestation के साथ `retention-days` plan |

CD003 और CD005 डिफ़ॉल्ट रूप से बंद हैं। CD002, CD003 और CD004 patches नहीं बनाते। CD005 असामान्य runs को सीमित करता है; normal execution छोटा नहीं करता। CD008 artifact storage का retention बदलता है, runner minutes नहीं। जब तक plan की समीक्षा और result की measurement न हो, हर plan केवल hypothesis है।

## समर्थित npm cache उदाहरण

CD006 केवल एक संकरा रूप पहचानता है: supported `actions/setup-node@v7` step के तुरंत बाद `npm ci`, साथ में tracked manifest और lockfile। Plan केवल cache inputs जोड़ता है; versions, installation और tests जगह पर रहते हैं। यह उदाहरण मानता है कि `package.json` में `packageManager` या `devEngines.packageManager` में npm घोषित नहीं है; npm घोषित होने पर v7 खुद cache चालू कर देता है, इसलिए CI Diet अतिरिक्त cache प्रस्तावित नहीं करता।

**पहले**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
```

**बाद में**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: package-lock.json
      - run: npm ci
```

Plan command में `--step 1` इस YAML array का दूसरा step है: checkout step `0` है और setup-node step `1`. यह zero-based index है, step का label नहीं। pnpm, Bun, timeout, retention और मौजूदा guards के लिए [plugin guide](docs/guide/plugin.md) देखें।

## लिखने से पहले समीक्षा

Flow है **scan → preview → human approval → apply → measure**. Model tools, जिनमें `ci_diet_plan` शामिल है, edits preview करते हैं और plan digest बनाते हैं; वे approve, apply या revert नहीं कर सकते। Review screen पर व्यक्ति plan digest का suffix या change ID लिखकर approve, apply और revert कर सकता है। Local writes एक मौजूदा workflow file की byte ranges में बदलाव करते हैं।

```bash
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet measure --cwd . --change CHANGE_ID --before-runs 100,101 --after-runs 110,111 --network
ci-diet revert --cwd . --change CHANGE_ID
```

Approval केवल उसी plan के लिए है। Apply backup बनाता है, planned bytes बदलता है और source, dependency, policy, digest, lock तथा backup की जाँच करता है। Revert backup बहाल करता है। CI Diet commit, push, deploy, workflow run, branch protection बदलना या artifacts हटाना नहीं करता।

## सबूत और साफ़ सीमाएँ

- Measurement से पहले savings का दावा नहीं होता। History या workflow attribution अधूरी हो तो finding गलत हो सकती है।
- Dependency cache restore और save समय जोड़ सकता है। इसका overhead उस installation समय से बड़ा हो सकता है जिसे वह बचाता है; बराबर परिस्थितियों वाले cold और warm runs की तुलना करें और cache steps को शामिल करें।
- `measure` चुने गए वास्तविक runs की तुलना करता है और observed runner-time difference, success और rerun rates दिखाता है। यह उन samples के बारे में evidence है; causality या actual billing का proof नहीं।
- Settings page tool configuration save करता है और session-scoped reports तथा plans दिखाता है। यह खुद workflow optimize नहीं करता।
- Policy और evidence checks किसी उपयोगी edit को भी रोक सकते हैं। बदलाव रखने से पहले report, diff और repository की अपनी checks देखें।

| माप | अर्थ |
| --- | --- |
| `observedRunnerSeconds` | Collected runs में देखा गया runner समय |
| `modeledRoundedMinutes` | Per-job minutes को ऊपर की ओर round किया गया; केवल अनुमान |
| `listPriceUsd` | Embedded pricing snapshot से list-price estimate |
| `actualBilledUsd` | Actual bill सिद्ध होने तक `unknown` |

इन मानों को अलग रखने से modeled minutes billing claim नहीं बनते।

## दस्तावेज़

| ज़रूरत | पढ़ें |
| --- | --- |
| Install, settings, CLI, review और measurement | [Plugin guide](docs/guide/plugin.md) · [Measurement section](docs/guide/plugin.md#measuring-an-applied-change) |
| Normative product और contract map | [Specification index](docs/spec/README.md) |
| Rule guards, cost model, patches और storage | [Rules](docs/spec/rules.md) · [Cost model](docs/spec/cost-model.md) · [Patch model](docs/spec/patch-model.md) · [Storage](docs/spec/storage.md) |
| असली cache-overhead measurement | [2026-10-25 cache review](docs/measurements/2026-10-25-cache-review.md) |

<details>
<summary>Plugin defaults, migration और compatibility</summary>

नए DSH profiles `preflightEnabled`, `networkEnabled`, `localApplyEnabled` और CD001, CD002, CD004, CD006, CD008 चालू करते हैं। One-time migration `defaultsRevision: 2` record करता है; बाद में बदले switches और rule choices restart के बाद भी बने रहते हैं। CD003 और CD005 साफ़ रूप से चालू करने तक बंद रहते हैं। State paths, retention, quotas और मौजूदा billing inputs सुरक्षित रहते हैं।

Plugin DSH `>=0.2.1-rc.2 <0.3.0-0` और `>=0.2.2-rc.1 <0.3.0-0` को target करता है। DSH `0.3.0` supported नहीं है। Plugin preflight supported deploy commands को चलने से पहले जाँचता है, लेकिन network request या file change नहीं करता और opaque shells छोड़ देता है। CLI history के लिए `--network` चाहिए; plugin network switch केवल sync tool चलने पर `gh` calls की अनुमति देता है। वही commands `@latest` के साथ चलाकर update करें, फिर DSH restart करें।

</details>

## योगदान और license

Bug reports और सीमित दायरे के proposals [GitHub Issues](https://github.com/0disoft/dsh-ci-diet/issues) में भेजें। Rules या contracts बदलने से पहले [plugin guide](docs/guide/plugin.md) और [decisions](docs/spec/decisions.md) पढ़ें। विस्तृत specifications और public documentation English में हैं।

MIT © Rodisoft
