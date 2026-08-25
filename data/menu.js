// Freshly Lite menu knowledge
// Source: user-reviewed transcription PDF supplied on 2026-08-25.
// IMPORTANT: Preserve source wording/prices until management explicitly corrects an item.

const MENU = [
  {
    category: "Kanapki",
    items: [
      {
        name: "Falafel klasyczny",
        description: "Tradycyjne, chrupiące kotleciki z ciecierzycy podawane w chlebku pita z dodatkiem świeżej warzyw i sosu z tahini",
        pricePln: 18
      },
      {
        name: "Falafel z bakłażanem",
        description: "Tradycyjne, chrupiące kotleciki z ciecierzycy podawane w chlebku pita z dodatkiem świeżej warzyw i sosu z tahini",
        pricePln: 22
      }
    ]
  },
  {
    category: "Sałatki",
    items: [
      {
        name: "Tabule",
        size: "250g",
        description: "Orzeźwiająca sałatka z drobno siekanej natki pietruszki, pomidorów, mięty, cebuli oraz kaszy bulgur",
        pricePln: 25
      },
      {
        name: "Sałatka klasyczna",
        size: "150g",
        description: "Klasyczna, lekka sałatka ze świeżych sezonowych warzyw z oliwą i ziołami",
        pricePln: 19
      },
      {
        name: "Sałatka z burakiem",
        size: "200g",
        description: "Burak, granat, natka pietruszki, sos ze cytryny, oliwa z oliwek, sól, kumin.",
        pricePln: 15
      },
      {
        name: "Sałatka Halloumi",
        size: "200g",
        description: "Grillowany ser halloumi, mix sałat, pomidor, granat, sos.",
        pricePln: 22
      }
    ]
  },
  {
    category: "Zestawy",
    items: [
      {
        name: "Falafel",
        description: "Tradycyjne, chrupiące kotleciki z ciecierzycy, z przyprawami",
        pricePln: 30
      },
      {
        name: "Halloumi",
        description: "Ciecierzyca, sos z tahini, sól ze cytryny, sól.",
        pricePln: 30
      },
      {
        name: "Kibbeh wegeteriańska",
        description: "Kasza, cebula, soja, masło roślinne, orzechy włoskie, sól, pieprz.",
        size: "2 szt.; waga 1 sztuki ok. 90 g",
        pricePln: 33
      },
      {
        name: "Ostre ziemniaki",
        description: "Kawałki ziemniaków smażone z kolendrą, czosnkiem i pastą z ostrej papryki.",
        pricePln: 20
      }
    ]
  },
  {
    category: "Dania",
    items: [
      {
        name: "Muhammara",
        description: "Pasta z ostrej papryki, orzechy włoskie, bułka tarta, oliwa z oliwek, sos granatowy, tahina.",
        pricePln: 25
      },
      {
        name: "Hummus klasyczny",
        description: "Ciecierzyca, sos z tahini, sól z cytryny, sól.",
        pricePln: 22
      },
      {
        name: "Falafel",
        size: "7 szt.",
        description: "Tradycyjne, chrupiące kotleciki z ciecierzycy z przyprawami",
        pricePln: 14
      },
      {
        name: "Kibbeh wegeteriańska",
        description: "Kasza, cebula, soja, masło roślinne, orzechy włoskie, sól, pieprz.",
        size: "2 szt.; waga 1 sztuki ok. 90 g",
        pricePln: 20
      },
      {
        name: "Halloumi Burger",
        size: "ok. 300 g",
        description: "Burger z grillowanym serem halloumi, pomidorem, rukolą, sałatą i sosem jogurtowym w bułce brioche.",
        pricePln: 17
      },
      {
        name: "Mutabbal AWOKADO",
        description: "pasta z awokado, sos z tahini, sól z cytryny, sól.",
        pricePln: 25
      },
      {
        name: "Ostre ziemniaki",
        description: "Kawałki ziemniaków smażone z kolendrą, czosnkiem i pastą z ostrej papryki.",
        pricePln: 25
      },
      {
        name: "Frytki",
        description: "Złociste, chrupiące frytki ziemniaczane, idealnie jako samodzielna przekąska lub dodatek do zestawu",
        pricePln: 12
      },
      {
        name: "Dolma",
        size: "6 szt.",
        description: "Sześć sztuk tradycyjnych gołąbków z liści winogron, faszerowanych ryżem i aromatycznymi ziołami",
        pricePln: 15
      }
    ]
  },
  {
    category: "Zupy",
    items: [
      {
        name: "Zupa z soczewicy",
        size: "250ml",
        description: "Rozgrzewająca, gęsta zupa z czerwonej soczewicy, doprawiona kuminem i sokiem z cytryny.",
        pricePln: 19
      }
    ]
  },
  {
    category: "Napoje",
    items: [
      { name: "Ayran", size: "250 ml", pricePln: 6 },
      { name: "Coca cola", size: "330 ml", pricePln: 5 },
      { name: "Fanta", size: "330 ml", pricePln: 5 },
      { name: "Sprite", size: "330 ml", pricePln: 5 },
      { name: "Woda niegazowana", size: "330ml", pricePln: 5 },
      { name: "Woda gazowana", size: "330 ml", pricePln: 5 }
    ]
  }
];

function formatMenuForAI() {
  return MENU.map(section => {
    const lines = section.items.map(item => {
      const size = item.size ? ` | ${item.size}` : "";
      const description = item.description ? ` | ${item.description}` : "";
      return `- ${item.name}${size} | ${item.pricePln} zł${description}`;
    });
    return `## ${section.category}\n${lines.join("\n")}`;
  }).join("\n\n");
}

module.exports = { MENU, formatMenuForAI };
