const { Configuration, OpenAIApi } = require("openai");

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { image } = JSON.parse(event.body);
    if (!image) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No image provided' }) };
    }

    // Используем переменные, предоставленные AI Gateway
    const configuration = new Configuration({
      apiKey: process.env.GEMINI_API_KEY,
      basePath: process.env.GOOGLE_GEMINI_BASE_URL,
    });
    const openai = new OpenAIApi(configuration);

    // Шаг 1: распознавание продуктов
    const visionResponse = await openai.createChatCompletion({
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Какие продукты на этом фото? Перечисли их просто списком через запятую, без лишнего текста. Только названия продуктов." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }
          ]
        }
      ],
      max_tokens: 100,
    });

    const products = visionResponse.data.choices[0].message.content.trim();
    console.log('Распознанные продукты:', products);

    // Шаг 2: генерация рецепта в формате JSON
    const recipeResponse = await openai.createChatCompletion({
      model: "gemini-2.0-flash",
      messages: [
        { 
          role: "system", 
          content: "Ты креативный шеф-повар. Предложи интересный рецепт из этих продуктов. Если продуктов мало, предложи рецепт с минимальными добавками (соль, масло, вода — считай, что они есть). Ответ дай в формате JSON со следующими полями: title (название блюда), ingredients (массив объектов с полями name и quantity), steps (массив строк), detected_products (массив распознанных продуктов)."
        },
        { role: "user", content: `Вот продукты: ${products}` }
      ],
      temperature: 0.8,
      response_format: { type: "json_object" }
    });

    const recipeData = JSON.parse(recipeResponse.data.choices[0].message.content);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(recipeData),
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to generate recipe: ' + error.message }),
    };
  }
};