# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

**État :** alpha ; `dsh-ci-diet@0.3.1` est publié sur npm. L’arbre source actuel ajoute l’écran de revue **Réglages → CI Diet Reports** aux contrats, aux moteurs d’analyse et de correctifs, à la CLI, aux outils DSH, à la page Réglages et au rapport HTML autonome. La vérification E2E dans un DSH réel reste à faire. Les écritures locales de workflow sont désactivées par défaut.

CI Diet repère le travail GitHub Actions probablement inutile, conserve les preuves associées à chaque constat et prévisualise de petites modifications de workflow pour qu’une personne les examine.

**L’installation seule ne permet pas d’économiser des minutes de runner.** Les commandes de déploiement DSH prises en charge recherchent automatiquement des candidats d’économie avant de s’exécuter ; les modifications de workflow ne sont appliquées qu’après examen et approbation. Le plugin DSH n’a pas d’outils d’approbation, d’application ou d’annulation, et preflight ne modifie jamais de fichier. Ses pages Réglages stockent la configuration et affichent les rapports et plans de session fournis par l’hôte ; elles n’optimisent pas un workflow. Les écritures locales approuvées sont désactivées par défaut. Rien ne garantit qu’un constat réduise le coût.

`preflightEnabled` est activé par défaut. Avant un `git push`, `npm|pnpm|bun publish`, `wrangler deploy` ou `npm|pnpm|bun run deploy` littéral dans un outil bash DSH sans état pris en charge (avec argument `workdir`), CI Diet effectue une vérification hors ligne. Il signale pour examen les candidats npm CD006, l’absence de concurrency dans un workflow réservé aux PR et une installation Bun frozen sans cache de téléchargement explicite. Si un candidat existe, la première commande ne s’exécute pas ; après examen, le modèle peut relancer la même commande. Aucun accès réseau ni modification automatique de fichier n’a lieu, et l’application d’un plan demande toujours une approbation humaine. Les shells persistants et les wrappers shell complexes ne sont pas identifiés de façon fiable, donc preflight les ignore. L’économie reste non mesurée, donc aucun gain n’est affirmé.

## Ce qu’il fait

Le scan statique lit le YAML des workflows dans un checkout cible. La synchronisation facultative de l’historique utilise des appels `gh api` en lecture seule pour collecter les exécutions récentes. Les constats comportent un niveau de preuve (`observed`, `inferred` ou `static`) et une couverture de collecte par axe.

| Règle | Ce qu’elle détecte | Modification possible |
| --- | --- | --- |
| CD001 | Exécutions de PR rendues obsolètes par un commit plus récent | modification de `concurrency` |
| CD002 | Déclencheurs qui se chevauchent | explication uniquement |
| CD003 | Vérifications lourdes pour des changements documentaires | explication uniquement ; désactivée par défaut |
| CD004 | Matrices surdimensionnées | explication uniquement |
| CD005 | Tâches sans `timeout-minutes` | modification du délai d’expiration ; désactivée par défaut |
| CD006 | Tâches `actions/setup-node@v3` ou `@v4` qui lancent `npm ci` sans cache npm | deux entrées setup-node ; activée par défaut |
| CD008 | Rétention prolongée des artefacts | modification de la rétention |

CD001 aide à traiter les exécutions de PR qui se chevauchent et sont devenues obsolètes. CD005 limite les exécutions anormales ; elle ne réduit pas la durée d’exécution normale d’une tâche. CD008 modifie la rétention du stockage des artefacts, et non les minutes de runner. CD003 et CD005 restent désactivées jusqu’à ce qu’elles réussissent leurs contrôles de qualité. CD006 est une règle statique active par défaut pour une forme npm étroite : elle ajoute le cache de téléchargement de setup-node tandis que `npm ci` et tous les tests s’exécutent toujours. Le cache peut réduire les téléchargements une fois alimenté ; aucun gain de temps ni d’argent n’est affirmé avant de comparer des exécutions à froid et à chaud.

## Installation et mise à jour

La CLI exige Node `^22.19.0 || >=24.0.0`. Le plugin prend en charge DSH `>=0.2.1-rc.2 <0.3.0-0` et `>=0.2.2-rc.1 <0.3.0-0`. La version `0.3.1` a été testée avec DSH `0.2.1-rc.2` ; DSH `0.3.0` n’est pas pris en charge.

```
npm install --global dsh-ci-diet@0.3.1
ci-diet --version
```

Si vous ne faites pas d’installation globale, remplacez le nom de commande `ci-diet` par `npx dsh-ci-diet@0.3.1`, par exemple `npx dsh-ci-diet@0.3.1 report --cwd .`.

```
dsh plugin --profile web add dsh-ci-diet@0.3.1
dsh --profile web
```

L’installation enregistre les outils du plugin, la page Réglages et l’écran de revue **Réglages → CI Diet Reports**. L’accès réseau et les écritures locales de workflow approuvées sont désactivés par défaut, et le démarrage de DSH ne lance aucun scan ni ne modifie aucun workflow.

```
npm install --global dsh-ci-diet@latest
dsh plugin --profile web add dsh-ci-diet@latest
```

Redémarrez DSH après la mise à jour du plugin. Utilisez `dsh plugin --profile web list`, `ci-diet --version` ou `npx dsh-ci-diet@latest --version` pour vérifier les versions installées.

## Premier scan et rapport d’historique

Exécutez ces commandes depuis le dépôt que vous voulez inspecter. `--cwd .` désigne ce dépôt ; `--cwd` accepte un autre chemin, et les chemins relatifs sont résolus depuis le répertoire de travail effectif. La première commande fonctionne sans réseau. La collecte de l’historique est une activation réseau distincte et explicite.

```
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`scan` affiche un rapport statique sans accès réseau ; `--json` ou `--out FILE` écrit cette sortie, mais le scan de la CLI n’enregistre pas de rapport dans le stockage d’état. `report` exige un rapport enregistré par `sync` de la CLI, par `ci_diet_scan` du plugin ou par `ci_diet_sync` du plugin. Dans cette séquence utilisant uniquement la CLI, sync enregistre le rapport ; l’option HTML écrit ensuite un seul fichier autonome. La synchronisation de l’historique exige que `gh` soit installé, authentifié et capable de lire les exécutions et tâches Actions du dépôt. `sync --network` est l’activation explicite de la CLI. Elle n’a jamais besoin d’un droit d’écriture sur GitHub. Un historique partiel produit et enregistre tout de même un rapport, en signalant une couverture incomplète. Le `ci_diet_scan` hors ligne du plugin enregistre bien son rapport, donc `ci_diet_report` peut le suivre directement.

Pour le plugin DSH, l’accès réseau est désactivé par défaut. Ouvrez **Réglages → CI Diet**, activez **Autoriser l’accès réseau**, puis choisissez **Enregistrer**. Le réglage de la page s’applique aux outils du plugin ; il n’active pas l’option `--network` de la CLI. Le scan statique et le rapport fonctionnent sans réseau. Après l’activation, `ci_diet_sync` utilise le même `gh` authentifié avec un accès en lecture. La page Réglages ne lance aucune optimisation à elle seule.

Une demande utile dans le chat rend explicites la séquence et la limite de la revue. Remplacez le chemin absolu de l’exemple par celui de votre dépôt :

> Exécute `ci_diet_scan` avec le cwd `C:\work\my-repo`. Une fois que j’aurai activé l’accès réseau dans Réglages → CI Diet, exécute `ci_diet_sync` pour ce même cwd, puis `ci_diet_report`. Si tu prévisualises un correctif avec `ci_diet_plan`, affiche uniquement les modifications. N’approuve, n’applique et n’annule rien ; ne fais aucun commit, aucun push et aucun déploiement.

La prévisualisation du plugin n’enregistre pas de plan. Son `nextCommand` recrée le plan via la CLI afin que le plan soit durable et puisse entrer dans le flux d’approbation humaine.

## Plan hors ligne pour le cache npm (CD006)

CD006 n’a pas besoin de l’historique des exécutions. Elle reconnaît une tâche à la racine du dépôt où `actions/checkout` n’a aucune option `with` fournie par l’utilisateur, suivie d’exactement une étape `actions/setup-node@v3` ou `@v4` sans cache, puis d’une étape dont le `run` vaut exactement `npm ci`. Les fichiers `package.json` et `package-lock.json` de la racine doivent être versionnés comme des fichiers JSON ordinaires. Le plan ajoute uniquement `cache: npm` et `cache-dependency-path: package-lock.json` à setup-node ; il ne change ni Node, ni les versions d’action, ni `npm ci`, ni les tests, ni la mise en cache locale.

```
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
```

`--step` est l’index commençant à zéro de l’étape setup-node ; l’exemple suppose checkout en 0 et setup-node en 1. La CLI `plan` exécute cette analyse statique en mémoire et enregistre le plan sans `sync` préalable ; elle laisse le dernier rapport enregistré intact. L’outil de plugin `ci_diet_plan` a toujours besoin d’un rapport enregistré ; lancez donc `ci_diet_scan` d’abord. L’approbation et l’application utilisent les commandes existantes ci-dessous. Le plan et son attestation sont enregistrés pendant la planification ; aucun fichier de workflow ne change avant qu’une personne approuve le plan et lance apply.

## Référence des commandes CLI

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

`scan` vérifie les fichiers de workflow. `sync` lit l’historique uniquement après `--network` ; `--repo` sélectionne explicitement `OWNER/REPO` et `--days` ajuste la période rétrospective dans les limites configurées. `report` produit du texte, du JSON ou du HTML et écrit `--out` relativement à `--cwd`. `diagnose` explique la correspondance des noms de tâches et la couverture à partir de l’historique enregistré ; ajoutez `--require-complete` pour sortir avec le code `3` lorsque les données sont incomplètes. `prune` supprime les rapports, plans et entrées de cache expirés selon la configuration du stockage d’état. `changes` liste les modifications appliquées ; `plans` rouvre un plan enregistré. `--config FILE` fusionne une configuration JSON partielle pour n’importe quelle commande.

## Examiner, approuver, appliquer et annuler

Un `plan` réussi de la CLI affiche le diff proposé, un véritable identifiant de plan tel que `p_...` et une confirmation formée à partir des 12 derniers caractères du digest du plan. La création du plan refuse les preuves obsolètes et les autres écritures risquées ; un workflow manquant peut être une erreur d’utilisation avec le code de sortie `1`. Si un plan enregistré est consulté après la disparition de son workspace ou de son workflow, `plans --plan` masque le diff, conserve le JSON du plan, demande de replanifier et sort avec `3`. Il en va de même lorsque les octets du workflow ne correspondent plus au hash source enregistré. Examinez de nouveau le diff et le plan avant d’approuver.

```
ci-diet plan --cwd . --rule CD001 --workflow .github/workflows/ci.yml --claims ci-only,replace-safe
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet revert --cwd . --change CHANGE_ID
```

Remplacez `PLAN_ID` par l’identifiant affiché par le plan, `CONFIRMATION` par les 12 derniers caractères de son digest et `CHANGE_ID` par l’identifiant affiché par apply. Chaque valeur est un argument littéral ; ne saisissez pas de chevrons. `approve` crée une approbation à usage unique, `apply` ne réécrit que la plage d’octets prévue dans un fichier de workflow et `revert` restaure la sauvegarde de cette modification. Examinez le diff obtenu et lancez les vérifications du dépôt selon vos besoins. CI Diet ne fait aucun commit, push ni déploiement, n’exécute aucun workflow, ne modifie pas la protection des branches et ne supprime aucun artefact.

Pour une CI éligible qui ne s’exécute que sur les PR, l’exemple CD001 utilise `ci-only` et `replace-safe` comme attestations humaines. Elles indiquent que l’opérateur a examiné la sémantique d’annulation ; ce ne sont pas des interrupteurs de contournement. CD005 nécessite un `--job` et un `--minutes` mesurés, et CD008 nécessite `--job`, un index numérique de tableau `--step` commençant à zéro pour l’étape cible, ainsi que des déclarations concernant les artefacts. CD006 nécessite `--job` et l’index `--step` commençant à zéro de l’étape setup-node ; elle ne demande aucune déclaration. Pour les deux règles d’étape, le nombre est un index de tableau, pas un jeton fondé sur le nom de l’étape.

## État et limites

La CLI et le plugin partagent le répertoire d’état par défaut : `%LOCALAPPDATA%\CI-Diet\profiles\default` sous Windows, sinon `~/.local/state/ci-diet/profiles/default`. Une valeur `stateDir` définie dans le plugin désigne un stockage distinct ; transmettez le même chemin absolu à la CLI avec `--state-dir` pour `plan`, `approve`, `apply` et `revert`. Les chemins relatifs de `--state-dir` de la CLI sont résolus par rapport au `--cwd` effectif. L’état existant n’est jamais migré automatiquement d’un répertoire à l’autre.

Le client Web propose Réglages et l’écran de revue **CI Diet Reports**. Les contrôles de rapport, d’approbation, d’application et d’annulation sont implémentés, mais la vérification E2E dans un DSH réel reste à faire. L’approbation et l’application passent par l’hôte depuis cet écran, et `localApplyEnabled` est désactivé par défaut. Aucun outil du plugin n’effectue d’approbation ni d’application. Un plan modifie un seul workflow existant par plages d’octets et refuse les structures non prises en charge. Les constats peuvent être erronés ou incomplets lorsque l’historique ou l’attribution des workflows est partiel, et un autre système peut disposer de données de facturation plus précises. Utilisez le rapport comme preuve pour la revue, puis vérifiez l’effet dans GitHub.

## Coût et preuves

| Champ | Signification |
| --- | --- |
| `observedRunnerSeconds` | Temps de runner enregistré par les exécutions collectées |
| `modeledRoundedMinutes` | Minutes par tâche arrondies à l’entier supérieur pour la modélisation |
| `listPriceUsd` | Coût selon l’instantané des tarifs catalogue intégré |
| `actualBilledUsd` | Toujours `null` tant que la facture réelle ne peut pas être prouvée |

Les rapports intègrent l’instantané des tarifs et un hash du contenu afin de permettre de reproduire les chiffres. Ils ne promettent pas d’économies automatiques. Le rapport HTML utilise du CSS en ligne, ne contient aucun script et ne fait aucune requête externe.

## Langues

L’interface Réglages de DSH, les messages de la CLI, les rapports HTML et ces six READMEs prennent en charge l’anglais, le coréen, le chinois simplifié, l’hindi, l’espagnol et le français. Les spécifications détaillées restent en anglais. L’ordre de sélection est `--lang`, la locale DSH, `LC_ALL`/`LC_MESSAGES`/`LANG`, puis l’anglais. Les codes de langue de la CLI sont `en`, `ko`, `zh-Hans`, `hi`, `es` et `fr` ; remplacez `ko` dans la commande d’exemple par le code souhaité. Les étiquettes régionales sont résolues par langue. Les rapports sont stockés en anglais et localisés au moment de l’affichage. Les identifiants de règle, codes d’erreur, valeurs d’énumération, chemins, hashes et nombres restent littéraux. L’attribut `lang` du HTML suit la locale sélectionnée. Les descriptions des outils DSH sont capturées au chargement du plugin ; rechargez donc après avoir changé la préférence de langue de DSH.

## Développement

```
bun install
node scripts/test-core.mjs
node scripts/gen-types.mjs --check
node scripts/sync-contracts.mjs --check
bun run typecheck
bun run lint
bun run test:docs
```

Exécutez les tests avec Node afin que les points d’entrée publiés restent compatibles avec Node. Bun sert uniquement à gérer les dépendances.

## Publication

Pousser une étiquette qui correspond à `package.json` démarre `.github/workflows/publish.yml`. Dans les commandes suivantes, remplacez le littéral `VERSION` dans les deux arguments par une nouvelle version ; la version `0.3.1` est déjà publiée, donc ne recréez pas cette étiquette.

```
git tag vVERSION
git push origin vVERSION
```

Le workflow compare l’étiquette à `package.json`, exécute les vérifications de publication, refuse une version npm déjà existante et publie avec la publication de confiance npm via GitHub OIDC. Le publieur de confiance doit nommer `publish.yml`.

## Structure

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

Les documents détaillés de spécification, de règles, de coûts, de correctifs, de stockage et de décision sont en anglais. L’index de la spécification est [docs/spec/README.md](docs/spec/README.md). Sont également disponibles, en anglais : [rules](docs/spec/rules.md), [cost model](docs/spec/cost-model.md), [patch model](docs/spec/patch-model.md), [storage and errors](docs/spec/storage.md), [decisions](docs/spec/decisions.md), [measurement](docs/spikes/a0a-rules.md), le [plugin and CLI guide](docs/guide/plugin.md) et [contract provenance](contracts/UPSTREAM.md).

## Licence

MIT
