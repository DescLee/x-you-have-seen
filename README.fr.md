# Seen · Historique de navigation X

**Langues / Languages:** [简体中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Seen est une extension Chrome/Edge Manifest V3 pour ordinateur. Elle mémorise localement les publications réellement consultées sur X (anciennement Twitter), puis permet de les rechercher depuis un panneau ancré à la colonne de droite ou depuis une page d’historique indépendante.

Elle répond à un problème concret : le fil X évolue vite et une publication lue quelques secondes plus tôt devient difficile à retrouver. Seen n’utilise pas l’API X, ne demande pas de compte supplémentaire et n’envoie pas vos données de navigation à un serveur.

## Fonctionnalités

- Enregistrement après au moins 50 % de visibilité et un temps de lecture configurable (0,8 / 1 / 1,5 / 2 s).
- Prise en charge des publications classiques, longues, citées, des images, vidéos/GIF et des Articles X.
- Pause automatique dans les onglets en arrière-plan, lorsque la fenêtre perd le focus, ou sur les pages Messages, Grok et Paramètres.
- Recherche dans le texte, l’auteur, le nom d’utilisateur, les citations et les titres/résumés d’Articles.
- Filtres : tout, texte, images, vidéos/GIF et Articles.
- Plages de consultation personnalisées et raccourcis Aujourd’hui, 7 derniers jours, 30 derniers jours.
- Le panneau reste dans la colonne de droite, se met à jour pendant la navigation et n’affiche les re-rendus que lorsque les données changent.
- Noms d’auteurs cliquables, lien vers la publication originale, cartes d’Articles avec couverture/titre/résumé et aperçu d’images conservant leur ratio.
- Page indépendante : tri, pagination stable, suppression unitaire ou groupée, pause, import/export JSON et thèmes clair/sombre/système.

## Technologies et fonctionnement

TypeScript, Manifest V3, Dexie 4/IndexedDB, esbuild, tests Node.js/tsx/fake-indexeddb, IntersectionObserver, MutationObserver, `requestIdleCallback` et Web Workers.

Le script de contenu extrait les éléments `article[data-testid="tweet"]`, observe leur visibilité et crée un événement après le temps requis. Le service worker regroupe les événements et les écrit dans IndexedDB. La recherche utilise du texte normalisé, des index auteur/n-grammes et des curseurs stables. Le panneau vérifie l’état toutes les trois secondes et reçoit aussi les événements `history-changed`.

## Confidentialité

Les données restent dans l’IndexedDB du profil navigateur courant. Il n’y a ni API distante, ni télémétrie, ni compte, ni téléversement. Les médias acceptés proviennent uniquement de `pbs.twimg.com`. Les imports sont validés et le texte est échappé avant affichage.

## Installation

Prérequis : Node.js 18+ et Chrome 116+ (ou une version Edge équivalente).

```bash
git clone https://github.com/DescLee/x-you-have-seen.git
cd x-you-have-seen
npm install
npm run build
```

Dans `chrome://extensions` ou `edge://extensions`, activez le mode développeur, choisissez **Charger l’extension non empaquetée** et sélectionnez `dist/`. Autorisez l’accès à `x.com` et `twitter.com`, puis rechargez X.

```bash
npm run package
```

Cette commande produit `release/seen-0.1.0.zip` et son fichier SHA-256.

## Vérification

```bash
npm run typecheck
npm test
npm run check
npm run package
```

Les tests couvrent la visibilité, le temps de lecture, la fusion, la recherche multilingue, les cartes média/Article, les dates, la pagination, les sauvegardes et les limites de sécurité. Les scripts navigateur se trouvent dans `scripts/qa-*.js`.

## Limites connues

- Produit pour les pages X de bureau ; les pages mobiles ne sont pas prises en charge.
- Une évolution du DOM de X peut nécessiter une mise à jour de `src/extract.ts`.
- Les images et couvertures dépendent d’URL `pbs.twimg.com` encore accessibles.
- L’historique est propre à chaque profil navigateur et n’est pas synchronisé entre appareils.

## Licence

Aucun fichier de licence n’est encore fourni. Ajoutez la licence correspondant à vos objectifs de redistribution et d’usage commercial avant de publier des dérivés.
