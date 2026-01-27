/**
 * Weather Integration via Gemini Subagent
 *
 * Instead of calling a weather API directly, we generate prompts
 * that the Gemini subagent can use to fetch current weather info.
 */

export interface WeatherPromptOptions {
  location: string;
  includeAlerts?: boolean;
  includeForecast?: boolean;
  forecastDays?: number;
}

const DEFAULT_LOCATION = "Bellevue, WA";

/**
 * Generate a prompt for Gemini to fetch current weather
 */
export function getWeatherPrompt(
  locationOrOptions?: string | WeatherPromptOptions
): string {
  const options: WeatherPromptOptions =
    typeof locationOrOptions === "string"
      ? { location: locationOrOptions }
      : locationOrOptions ?? { location: DEFAULT_LOCATION };

  const {
    location = DEFAULT_LOCATION,
    includeAlerts = true,
    includeForecast = true,
    forecastDays = 3,
  } = options;

  let prompt = `What is the current weather in ${location}? `;
  prompt += `Include: temperature (in Fahrenheit), feels-like temperature, conditions, humidity, and wind speed/direction. `;

  if (includeForecast) {
    prompt += `Also include a ${forecastDays}-day forecast with highs, lows, and conditions. `;
  }

  if (includeAlerts) {
    prompt += `Include any active weather alerts or warnings for the area. `;
  }

  prompt += `Format the response in a concise, readable way suitable for a brief daily summary.`;

  return prompt;
}

/**
 * Generate a brief weather prompt for morning briefings
 */
export function getBriefWeatherPrompt(location: string = DEFAULT_LOCATION): string {
  return `Give me a brief weather summary for ${location}: current temperature (Fahrenheit), conditions, and if rain/snow is expected today. Keep it to 2-3 sentences.`;
}

/**
 * Generate a detailed weather prompt
 */
export function getDetailedWeatherPrompt(location: string = DEFAULT_LOCATION): string {
  return getWeatherPrompt({
    location,
    includeAlerts: true,
    includeForecast: true,
    forecastDays: 5,
  });
}

/**
 * Default location for weather queries
 */
export const DEFAULT_WEATHER_LOCATION = DEFAULT_LOCATION;
