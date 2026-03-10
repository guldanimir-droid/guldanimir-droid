import OpenAI from "openai";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });

const getEnv = (key) => {
  if (globalThis.Netlify?.env?.get) {
    return Netlify.env.get(key);
  }

  return process.env[key];
};

const parseDataUrl = (imageBase64, mimeType) => {
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return { error: "Изображение не передано." };
  }

  if (imageBase64.startsWith("data:")) {
    const match = imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return { error: "Некорректный формат изображения." };
    }

    return {
      mimeType: match[1].toLowerCase(),
      base64Data: match[2],
    };
  }

  if (!mimeType || typeof mimeType !== "string") {
    return { error: "Не указан тип изображения." };
  }

  return {
    mimeType: mimeType.toLowerCase(),
    base64Data: imageBase64,
  };
};

const normalizeName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[.,;:!?"'`«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const splitDetectedProducts = (value) =>
  String(value || "")
    .split(/[\n,;]+/)
    .map((item) => item.replace(/^[-•\d.)\s]+/, "").trim())
    .filter(Boolean);

const toDetectedProductsArray = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  return splitDetectedProducts(value);
};

const extractJsonText = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");

  if (first >= 0 && last > first) {
    return raw.slice(first, last + 1);
  }

  return raw;
};

const parseRecipeJson = (value) => {
  const jsonText = extractJsonText(value);
  return JSON.parse(jsonText);
};

const toIngredientsArray = (ingredients) => {
  if (!Array.isArray(ingredients)) {
    return [];
  }

  return ingredients
    .map((item) => {
      if (typeof item === "string") {
        return {
          name: item.trim(),
          quantity: "по вкусу",
        };
      }

      return {
        name: String(item?.name || "").trim(),
        quantity: String(item?.quantity || "по вкусу").trim(),
      };
    })
    .filter((item) => item.name);
};

const toStepsArray = (steps) => {
  if (!Array.isArray(steps)) {
    return [];
  }

  return steps.map((step) => String(step || "").trim()).filter(Boolean);
};

const buildOzonSearchUrl = (productName) => {
  const params = new URLSearchParams({
    text: productName,
    utm_source: "zest_smart",
    utm_medium: "referral",
    utm_campaign: "recipe",
  });
  return `https://www.ozon.ru/search/?${params.toString()}`;
};

const collectMissingIngredients = (ingredients, detectedProducts) => {
  const detectedSet = new Set(detectedProducts.map((item) => normalizeName(item)).filter(Boolean));

  return ingredients
    .filter((ingredient) => {
      const ingredientName = normalizeName(ingredient.name);
      if (!ingredientName) {
        return false;
      }

      for (const detectedName of detectedSet) {
        if (
          ingredientName === detectedName ||
          ingredientName.includes(detectedName) ||
          detectedName.includes(ingredientName)
        ) {
          return false;
        }
      }

      return true;
    })
    .map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
      ozon_search_url: buildOzonSearchUrl(ingredient.name),
    }));
};

const buildFallbackRecipeText = (recipeData) => {
  const ingredientLines = recipeData.ingredients
    .map((item) => `- ${item.name}: ${item.quantity}`)
    .join("\n");

  const stepLines = recipeData.steps.map((item, idx) => `${idx + 1}. ${item}`).join("\n");

  return [
    `Название блюда: ${recipeData.title}`,
    "",
    "Ингредиенты:",
    ingredientLines || "- Нет данных",
    "",
    "Пошаговый рецепт:",
    stepLines || "1. Нет данных",
  ].join("\n");
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  const openAiApiKey = getEnv("OPENAI_API_KEY");
  if (!openAiApiKey) {
    return json(500, { error: "OPENAI_API_KEY не настроен в переменных окружения." });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Тело запроса должно быть JSON." });
  }

  const parsed = parseDataUrl(payload?.imageBase64, payload?.mimeType);
  if (parsed.error) {
    return json(400, { error: parsed.error });
  }

  const { mimeType, base64Data } = parsed;
  if (!SUPPORTED_TYPES.has(mimeType)) {
    return json(400, { error: "Поддерживаются только JPEG и PNG." });
  }

  const imageBytes = Buffer.byteLength(base64Data, "base64");
  if (!Number.isFinite(imageBytes) || imageBytes <= 0) {
    return json(400, { error: "Пустое или поврежденное изображение." });
  }

  if (imageBytes > MAX_IMAGE_BYTES) {
    return json(400, { error: "Размер изображения должен быть не более 5 МБ." });
  }

  const client = new OpenAI({ apiKey: openAiApiKey });
  const visionModel = getEnv("OPENAI_VISION_MODEL") || "gpt-4.1-mini";
  const recipeModel = getEnv("OPENAI_RECIPE_MODEL") || "gpt-4.1-mini";

  try {
    const imageDataUrl = `data:${mimeType};base64,${base64Data}`;

    const visionResponse = await client.responses.create({
      model: visionModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Определи продукты на фото. Верни только список названий через запятую, без пояснений.",
            },
            {
              type: "input_image",
              image_url: imageDataUrl,
            },
          ],
        },
      ],
      max_output_tokens: 250,
    });

    const recognizedProductsText = visionResponse.output_text?.trim();
    const detectedProducts = splitDetectedProducts(recognizedProductsText);

    if (!detectedProducts.length) {
      return json(502, {
        error: "Не удалось распознать продукты на фото. Попробуйте другое изображение.",
      });
    }

    const recipePrompt = `Ты креативный шеф-повар. Предложи интересный рецепт из этих продуктов: ${detectedProducts.join(", ")}.
Если продуктов мало, предложи рецепт с минимальными добавками (соль, масло, вода — считай, что они есть).
Ответ верни ТОЛЬКО в виде JSON-объекта со следующими полями:
{
  "title": "Название блюда",
  "ingredients": [{"name": "помидор", "quantity": "2 шт"}],
  "steps": ["Шаг 1", "Шаг 2"],
  "detected_products": ["помидор", "чеснок"]
}
Пиши на русском языке.`;

    const recipeResponse = await client.responses.create({
      model: recipeModel,
      input: recipePrompt,
      max_output_tokens: 900,
    });

    const recipeRawText = recipeResponse.output_text?.trim();
    if (!recipeRawText) {
      return json(502, { error: "Не удалось сгенерировать рецепт. Попробуйте еще раз." });
    }

    let recipeJson;
    try {
      recipeJson = parseRecipeJson(recipeRawText);
    } catch {
      return json(502, {
        error: "AI вернул рецепт в некорректном формате. Попробуйте еще раз.",
      });
    }

    const recipeData = {
      title: String(recipeJson?.title || "Рецепт от Zest Smart").trim(),
      ingredients: toIngredientsArray(recipeJson?.ingredients),
      steps: toStepsArray(recipeJson?.steps),
      detected_products: toDetectedProductsArray(recipeJson?.detected_products),
    };

    if (!recipeData.detected_products.length) {
      recipeData.detected_products = detectedProducts;
    }

    const missingIngredients = collectMissingIngredients(
      recipeData.ingredients,
      recipeData.detected_products
    );
    recipeData.missing_ingredients = missingIngredients;

    const fallbackRecipeText = buildFallbackRecipeText(recipeData);

    return json(200, {
      recognizedProducts: detectedProducts.join(", "),
      recipe: fallbackRecipeText,
      recipeData,
      missingIngredients,
    });
  } catch (error) {
    const status = error?.status || 500;
    const message =
      error?.error?.message ||
      error?.message ||
      "Ошибка при обращении к AI-сервису.";

    return json(status, { error: message });
  }
};
