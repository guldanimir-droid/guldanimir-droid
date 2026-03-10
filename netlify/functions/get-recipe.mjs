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

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
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

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
  const recipeModel = process.env.OPENAI_RECIPE_MODEL || "gpt-4.1-mini";

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
              text: "Какие продукты на этом фото? Перечисли их просто списком через запятую. Если продукты неразличимы, так и напиши.",
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

    const recognizedProducts = visionResponse.output_text?.trim();

    if (!recognizedProducts) {
      return json(502, {
        error: "Не удалось распознать продукты на фото. Попробуйте другое изображение.",
      });
    }

    const recipePrompt = `Ты креативный шеф-повар. Предложи интересный рецепт из этих продуктов: ${recognizedProducts}.
Если продуктов мало, предложи рецепт с минимальными добавками (соль, масло, вода — считай, что они есть).
Ответ дай строго в формате:
Название блюда:
Ингредиенты (с количеством):
Пошаговый рецепт:
Недостающие продукты (если есть):`;

    const recipeResponse = await client.responses.create({
      model: recipeModel,
      input: recipePrompt,
      max_output_tokens: 900,
    });

    const recipe = recipeResponse.output_text?.trim();

    if (!recipe) {
      return json(502, { error: "Не удалось сгенерировать рецепт. Попробуйте еще раз." });
    }

    return json(200, {
      recognizedProducts,
      recipe,
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
