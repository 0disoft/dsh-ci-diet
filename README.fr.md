<p align="center"><img src="docs/assets/readme-banner.svg" alt="CI Diet" width="820"></p>

# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ci-diet"><img src="https://img.shields.io/npm/v/dsh-ci-diet.svg" alt="version npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="licence : MIT"></a>
  <a href="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml"><img src="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

**Repérez le temps de runner GitHub Actions probablement gaspillé, conservez les preuves et transformez les petites corrections en plans soumis à une revue humaine.**

CI Diet est une CLI et un plugin DeepSeek Harness (DSH) en phase alpha. Il lit les définitions de workflow et, lorsqu’il est activé, l’historique GitHub Actions ; il présente ensuite les constats et prépare des modifications YAML limitées sans modifier un workflow de lui-même.

## Installation

La CLI nécessite Node `^22.19.0 || >=24.0.0`. La version npm actuelle est `0.5.2`.

```bash
npm install --global dsh-ci-diet@0.5.2
ci-diet --version
dsh plugin --profile web add dsh-ci-diet@0.5.2
dsh --profile web
```

Le plugin enregistre les outils DSH ainsi que les écrans **Settings → CI Diet** et **Revue CI Diet**. L’installation seule n’analyse pas un dépôt, ne fait pas gagner de minutes runner et ne modifie pas un workflow. Sans installation globale de la CLI, utilisez `npx dsh-ci-diet@0.5.2` à la place de `ci-diet`.

## Premier scan et historique

Exécutez ces commandes depuis le dépôt à inspecter. Le scan statique fonctionne hors ligne et enregistre son rapport. La synchronisation de l’historique est une étape réseau distincte qui lit les exécutions et jobs récents via des requêtes en lecture seule à l’API GitHub avec la CLI `gh` authentifiée.

```bash
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`gh` a besoin d’un accès en lecture aux exécutions et aux jobs Actions du dépôt. CI Diet ne demande jamais d’accès en écriture à GitHub. Le rapport HTML est un fichier autonome avec CSS inline, sans scripts ni requêtes externes. Dans DSH, `ci_diet_scan` et `ci_diet_sync` enregistrent des rapports ; les nouveaux profils du plugin activent le réseau et la vérification préalable par défaut.

![Flux CI Diet : scan, preview, approbation humaine, apply et measure](docs/assets/workflow.svg)

## Ce qu’il détecte

<p align="center">
  <img src="docs/assets/settings-preview.png" alt="page de configuration CI Diet en interface coréenne avec la vérification préalable activée par défaut" width="560">
</p>
<p align="center"><sub>Settings → CI Diet configuration. Interface coréenne ; la vérification préalable est activée par défaut.</sub></p>

| Règle | Par défaut | Recherche | Sortie habituelle |
| --- | --- | --- | --- |
| CD001 | active | exécutions PR remplacées par un commit plus récent | plan `concurrency` |
| CD002 | active | candidats de trigger chevauchants ou en double | explication |
| CD003 | désactivée | contrôles lourds pour des changements déclarés limités à la documentation | explication |
| CD004 | active | matrices volumineuses résolubles statiquement | note de revue |
| CD005 | désactivée | jobs sans timeout | plan `timeout-minutes` mesuré |
| CD006 | active | jobs npm, pnpm ou Bun frozen-install pris en charge sans cache explicite | plan de cache de téléchargement |
| CD008 | active | rétention d’artifact plus longue que nécessaire | plan `retention-days` avec attestation humaine |

CD003 et CD005 sont désactivées par défaut. CD002, CD003 et CD004 ne produisent pas de patch. CD005 limite les exécutions anormales ; il ne raccourcit pas l’exécution normale. CD008 modifie la rétention du stockage d’artifacts, pas les minutes runner. Tout plan reste une hypothèse tant qu’il n’a pas été examiné et mesuré.

## Exemple de cache npm pris en charge

CD006 reconnaît une forme étroite : une étape `actions/setup-node@v7` prise en charge suivie de `npm ci`, avec un manifest et un lockfile suivis. Le plan ajoute uniquement des entrées de cache ; les versions, l’installation et les tests restent en place. Cet exemple suppose que `package.json` ne déclare pas npm dans `packageManager` ni dans `devEngines.packageManager` ; si npm est déclaré, v7 active le cache automatiquement et CI Diet ne propose donc pas de cache redondant.

**Avant**

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

**Après**

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

Dans une commande plan, `--step 1` désigne la deuxième étape de ce tableau YAML : checkout est l’étape `0` et setup-node l’étape `1`. C’est un index commençant à zéro, pas un libellé d’étape. Consultez le [guide du plugin](docs/guide/plugin.md) pour pnpm, Bun, les timeouts, la rétention et les protections actuelles.

## Vérifier avant d’écrire

Le flux est **scan → preview → human approval → apply → measure**. Les outils de modèle, dont `ci_diet_plan`, prévisualisent les modifications et calculent un plan digest ; ils ne peuvent ni approuver, ni appliquer, ni annuler. L’écran de revue permet d’approuver, d’appliquer et d’annuler après qu’une personne a saisi le suffixe du plan digest ou le change ID. Les écritures locales modifient des plages d’octets dans un seul workflow existant.

```bash
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet measure --cwd . --change CHANGE_ID --before-runs 100,101 --after-runs 110,111 --network
ci-diet revert --cwd . --change CHANGE_ID
```

Une approbation ne vaut que pour ce plan. L’application crée une sauvegarde, réécrit les octets prévus et vérifie source, dependency, policy, digest, lock et backup. L’annulation restaure la sauvegarde. CI Diet ne fait ni commit, ni push, ni deploy, n’exécute pas de workflow, ne modifie pas branch protection et ne supprime pas d’artifacts.

## Preuves et limites

- Aucun gain n’est affirmé avant mesure. Un constat peut être faux lorsque l’historique ou l’attribution du workflow est incomplet.
- Le cache de dépendances peut ajouter du temps de restore et de save. Son overhead peut dépasser le temps d’installation évité ; comparez des exécutions cold et warm équivalentes et incluez les étapes de cache.
- `measure` compare des exécutions réelles sélectionnées et montre la différence observée de runner time, les taux de succès et de relance. C’est une preuve sur ces échantillons, pas une preuve de causalité ni de la facture réelle.
- La page Settings enregistre la configuration des outils et affiche les rapports et plans liés à la session. Elle n’optimise pas un workflow à elle seule.
- Les contrôles de policy et de preuve peuvent bloquer une modification utile. Examinez le rapport, le diff et les vérifications du dépôt avant de conserver un changement.

| Mesure | Signification |
| --- | --- |
| `observedRunnerSeconds` | Temps runner observé dans les exécutions collectées |
| `modeledRoundedMinutes` | Minutes par job arrondies au supérieur ; une estimation seulement |
| `listPriceUsd` | Estimation au prix catalogue selon l’instantané de prix inclus |
| `actualBilledUsd` | `unknown` tant qu’une facture réelle n’est pas démontrée |

Garder ces valeurs séparées évite de transformer des minutes modélisées en affirmation de facturation.

## Documentation

| Besoin | À lire |
| --- | --- |
| Installation, réglages, CLI, revue et mesure | [Guide du plugin](docs/guide/plugin.md) · [Section mesure](docs/guide/plugin.md#measuring-an-applied-change) |
| Description normative et carte des contrats | [Index de spécification](docs/spec/README.md) |
| Protections des règles, modèle de coût, patches et storage | [Règles](docs/spec/rules.md) · [Modèle de coût](docs/spec/cost-model.md) · [Modèle de patch](docs/spec/patch-model.md) · [Storage](docs/spec/storage.md) |
| Une mesure réelle de l’overhead du cache | [Revue du cache du 2026-10-25](docs/measurements/2026-10-25-cache-review.md) |

<details>
<summary>Valeurs par défaut, migration et compatibilité du plugin</summary>

Les nouveaux profils DSH activent `preflightEnabled`, `networkEnabled`, `localApplyEnabled` et les règles CD001, CD002, CD004, CD006 et CD008. La migration unique enregistre `defaultsRevision: 2` ; les choix ultérieurs de switches et de règles survivent aux redémarrages. CD003 et CD005 restent désactivées jusqu’à leur activation explicite. Les chemins d’état, la rétention, les quotas et les entrées de facturation existantes sont conservés.

Le plugin cible DSH `>=0.2.1-rc.2 <0.3.0-0` et `>=0.2.2-rc.1 <0.3.0-0`. DSH `0.3.0` n’est pas pris en charge. La vérification préalable du plugin examine les commandes de déploiement prises en charge avant leur exécution, mais ne fait aucune requête réseau ni modification de fichier et ignore les shells opaques. L’historique CLI nécessite `--network` ; l’interrupteur réseau du plugin autorise les appels à `gh` uniquement lorsque l’outil de sync est invoqué. Mettez à jour avec les mêmes commandes et `@latest`, puis redémarrez DSH.

</details>

## Contribution et licence

Les rapports de bug et les propositions ciblées sont bienvenus dans [GitHub Issues](https://github.com/0disoft/dsh-ci-diet/issues). Avant de modifier une règle ou un contrat, lisez le [guide du plugin](docs/guide/plugin.md) et les [décisions](docs/spec/decisions.md). Les spécifications détaillées et la documentation publique sont en anglais.

MIT © Rodisoft
