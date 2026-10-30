# Mes Recettes

Web app de recettes de cuisine, sans serveur ni build : HTML, CSS et JavaScript, hébergée sur GitHub Pages.
Les données (recettes, ingrédients, catégories) sont dans [`data/recipes.json`](data/recipes.json), dans ce dépôt.

## Fonctionnalités

- **Recettes** : titre, catégories, portions, temps de préparation/cuisson, description, photo (URL), notes, source.
- **Ingrédients** : chaque recette a ses ingrédients (quantité, unité, précision). Les quantités s'ajustent au nombre de portions.
  Une liste d'ingrédients se colle d'un coup (« 200 g de farine », « 3 œufs »…).
- **Catalogue d'ingrédients** (onglet 🥕) : ajouter, renommer (fusionne les doublons), supprimer.
- **Recherche par ingrédients** : indique ce que tu as sous la main ; les recettes sont classées par ingrédients
  en commun et affichent ce qui manque. Option « contient tous ces ingrédients ».
- **Minuteurs intégrés** : bouton ⏱ par étape, et toute durée écrite dans une étape (« cuire 10 min », « 1 h 30 »)
  se lance d'un toucher. Plusieurs minuteurs en même temps, pause, +1 min, sonnerie + vibration,
  ils continuent après un rechargement de la page. Option pour garder l'écran allumé pendant la recette.
- **Catégories** (onglet 🏷️) avec emoji, filtre sur l'accueil, favoris ★.
- Hors ligne et installable sur l'écran d'accueil (Safari → Partager → « Sur l'écran d'accueil »).

## Mise en ligne

Settings → Pages → *Deploy from a branch* → `main` / `(root)`. Le site est alors sur
`https://scoubybinks.github.io/recette/`.

## Enregistrement des données sur GitHub

Sans configuration, l'app lit `data/recipes.json` depuis GitHub et garde tes modifications sur l'appareil.
Pour qu'elles soient enregistrées dans le dépôt (et visibles sur tous tes appareils) :

1. Crée un jeton *fine-grained* : <https://github.com/settings/personal-access-tokens/new>
   - Repository access : *Only select repositories* → `recette`
   - Permissions → Repository permissions → **Contents : Read and write**
2. Dans l'app, onglet ⚙️ **Sync**, colle le jeton et enregistre.

Chaque modification crée alors un commit sur `data/recipes.json` via l'API GitHub. Si le fichier a changé
entre-temps (autre appareil, modification à la main), les deux versions sont fusionnées recette par recette
(la plus récente l'emporte, les suppressions sont conservées). Le jeton reste dans le navigateur de l'appareil.

## Structure

```
index.html            page unique
style.css             styles (clair/sombre)
js/app.js             vues et navigation
js/store.js           données, cache local, synchronisation et fusion
js/github.js          API GitHub (lecture/commit du fichier JSON)
js/timers.js          minuteurs
js/utils.js           utilitaires (quantités, durées, recherche)
data/recipes.json     les données
sw.js                 cache hors ligne
```
