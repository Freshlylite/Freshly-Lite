// Verified Freshly Lite restaurant knowledge.
// Keep operational facts here, separate from the permanent Core prompt.

const RESTAURANT = {
  name: "Freshly Lite",

  address: {
    full: "Jana Pawła II 45A/51A, 01-008 Warszawa",
    city: "Warszawa",
    country: "Poland",
    directions: {
      ar: "للوصول إلى المطعم: من جانب Millennium Bank يوجد درج يصعد إلى الطابق الأول.",
      en: "To reach the restaurant: next to Millennium Bank there are stairs leading up to the first floor.",
      pl: "Aby dotrzeć do restauracji: obok Millennium Bank znajdują się schody prowadzące na pierwsze piętro.",
      ru: "Чтобы попасть в ресторан: рядом с Millennium Bank есть лестница, ведущая на первый этаж."
    }
  },

  openingHours: {
    timezone: "Europe/Warsaw",
    schedule: {
      monday: { open: "11:00", close: "20:00" },
      tuesday: { open: "11:00", close: "20:00" },
      wednesday: { open: "11:00", close: "20:00" },
      thursday: { open: "11:00", close: "20:00" },
      friday: { open: "11:00", close: "20:00" },
      saturday: { open: "11:00", close: "20:00" },
      sunday: null
    }
  },

  supportedLanguages: ["Arabic", "English", "Polish", "Russian"],

  serviceOptions: {
    dineIn: true,
    pickup: true,
    directRestaurantDelivery: false,
    deliveryPolicy: "Delivery is available only through approved delivery applications. Freshly Lite does not currently provide direct restaurant delivery for normal orders."
  },

  knowledgeRules: {
    sourceStatus: "VERIFIED_BY_MANAGEMENT",
    noExternalLookup: true,
    unknownFactAction: "ASK_MANAGEMENT"
  }
};

function formatRestaurantForAI() {
  const hours = Object.entries(RESTAURANT.openingHours.schedule)
    .map(([day, value]) => value ? `${day}: ${value.open}-${value.close}` : `${day}: closed/not specified`)
    .join("\n");

  return [
    `Restaurant name: ${RESTAURANT.name}`,
    `Address: ${RESTAURANT.address.full}`,
    `Directions AR: ${RESTAURANT.address.directions.ar}`,
    `Directions EN: ${RESTAURANT.address.directions.en}`,
    `Directions PL: ${RESTAURANT.address.directions.pl}`,
    `Directions RU: ${RESTAURANT.address.directions.ru}`,
    `Opening hours (${RESTAURANT.openingHours.timezone}):\n${hours}`,
    `Supported languages: ${RESTAURANT.supportedLanguages.join(", ")}`,
    `Dine-in: yes`,
    `Pickup: yes`,
    `Direct restaurant delivery for normal orders: no`,
    `Delivery rule: ${RESTAURANT.serviceOptions.deliveryPolicy}`
  ].join("\n\n");
}

module.exports = { RESTAURANT, formatRestaurantForAI };
