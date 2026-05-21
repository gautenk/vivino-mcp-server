import axios from 'axios';
import { VivinoUserRating, VivinoWineDetails } from '../types';

const EXA_API_URL = 'https://api.exa.ai/search';

const COMMON_GRAPES = [
  'Cabernet Sauvignon', 'Merlot', 'Pinot Noir', 'Chardonnay', 'Sauvignon Blanc',
  'Syrah', 'Shiraz', 'Grenache', 'Riesling', 'Tempranillo', 'Sangiovese',
  'Nebbiolo', 'Malbec', 'Zinfandel', 'Petit Verdot', 'Cabernet Franc',
  'Viognier', 'Gewurztraminer', 'Pinot Gris', 'Pinot Blanc', 'Muscat',
  'Chenin Blanc', 'Semillon', 'Marsanne', 'Roussanne', 'Mourvedre',
  'Carignan', 'Cinsault', 'Barbera', 'Dolcetto', 'Primitivo',
  'Montepulciano', 'Vermentino', 'Fiano', 'Greco', 'Aglianico',
  'Garnacha', 'Monastrell', 'Albarino', 'Verdejo', 'Touriga Nacional',
  'Torrontes', 'Mencia', "Nero d'Avola", 'Corvina', 'Glera',
  'Petite Sirah', 'Carmenere', 'Tannat', 'Gruner Veltliner', 'Zweigelt',
];

const KNOWN_REGIONS = [
  'Napa Valley', 'Sonoma', 'Bordeaux', 'Burgundy', 'Champagne',
  'Rhône Valley', 'Rioja', 'Tuscany', 'Barolo', 'Chianti', 'Mosel', 'Rhine',
  'Alsace', 'Loire Valley', 'Provence', 'Languedoc', 'Priorat',
  'Ribera del Duero', 'Douro', 'Mendoza', 'Marlborough', 'Barossa Valley',
  'McLaren Vale', 'Margaret River', 'Stellenbosch', 'Willamette Valley',
  'Paso Robles', 'Santa Barbara', 'Saint-Émilion', 'Pomerol', 'Médoc',
  'Pauillac', 'Saint-Julien', 'Margaux', 'Haut-Médoc', 'Sauternes',
  'Chablis', 'Côte de Nuits', 'Côte de Beaune', 'Côte d\'Or',
  'Châteauneuf-du-Pape', 'Gigondas', 'Valpolicella', 'Barbaresco',
  'Brunello di Montalcino', "Montepulciano d'Abruzzo", 'Central Valley',
  'Finger Lakes', 'Columbia Valley', 'Central Otago', 'Hunter Valley',
];

const KNOWN_COUNTRIES: Record<string, string> = {
  'France': 'France', 'Italy': 'Italy', 'Spain': 'Spain',
  'United States': 'United States', 'Australia': 'Australia',
  'Argentina': 'Argentina', 'Chile': 'Chile', 'Germany': 'Germany',
  'Portugal': 'Portugal', 'New Zealand': 'New Zealand',
  'South Africa': 'South Africa', 'Austria': 'Austria',
  'Greece': 'Greece', 'Hungary': 'Hungary', 'USA': 'United States',
  'California': 'United States', 'Oregon': 'United States',
  'Washington': 'United States',
};

export async function fetchExaTastingNotes(
  rating: VivinoUserRating
): Promise<string | null> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return null;

  const query = [
    rating.winery_name,
    rating.wine_name,
    rating.vintage ? String(rating.vintage) : '',
    'wine tasting notes review flavors aromas',
  ].filter(Boolean).join(' ');

  try {
    const res = await axios.post(
      EXA_API_URL,
      {
        query,
        numResults: 3,
        useAutoprompt: false,
        type: 'neural',
        contents: { text: { maxCharacters: 4000 } },
      },
      {
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    );

    const results = (res.data?.results ?? []) as Array<{ text?: string; title?: string }>;
    const raw = results.map(r => `${r.text ?? ''}`).join(' ');

    // Strip navigation/header cruft common in scraped web content
    const text = raw
      .replace(/skip to (main )?content/gi, '')
      .replace(/#+ [^\n]*/g, '')
      .replace(/\b(new release|buy now|add to cart|in stock)[^.!?]*[.!?]?/gi, '')
      // Strip leading product-title text: everything up to and including a 4-digit year
      // that is followed by a space and a capital letter (the real sentence start)
      .replace(/^[^.!?]*?\b\d{4}\b\s+(?=[A-Z])/g, '')
      // Strip any remaining leading fragment that has no sentence-ending punctuation
      .replace(/^[^.!?]{0,120}\s+(?=[A-Z][a-z])/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract sentences that contain wine tasting language
    const flavorTerms = /\b(fruit|cherry|berry|plum|cassis|blackcurrant|raspberry|strawberry|blueberry|tannin|acid|oak|cedar|vanilla|spice|pepper|earthy|leather|tobacco|mineral|floral|herbal|finish|palate|nose|aroma|bouquet|body|smooth|crisp|dry|rich|full|medium|light|bold|complex|elegant|structured|balanced)\b/i;
    const sentences = text.split(/(?<=[.!?])\s+/);
    const relevant = sentences.filter(s => flavorTerms.test(s) && s.length > 30 && s.length < 400);

    if (!relevant.length) return null;
    // Return up to 3 relevant sentences, capped at 600 chars
    let notes = relevant.slice(0, 3).join(' ');
    if (notes.length > 600) notes = notes.slice(0, 597) + '...';
    return notes;
  } catch {
    return null;
  }
}

export async function fetchExaEnrichment(
  rating: VivinoUserRating
): Promise<Partial<VivinoWineDetails>> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return {};

  const query = [
    rating.winery_name,
    rating.wine_name,
    rating.vintage ? String(rating.vintage) : '',
    'wine region grapes variety appellation',
  ].filter(Boolean).join(' ');

  try {
    const res = await axios.post(
      EXA_API_URL,
      {
        query,
        numResults: 3,
        useAutoprompt: false,
        type: 'neural',
        contents: { text: { maxCharacters: 3000 } },
      },
      {
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    );

    const results = (res.data?.results ?? []) as Array<{ text?: string; title?: string }>;
    const text = results.map(r => `${r.title ?? ''} ${r.text ?? ''}`).join(' ');
    return extractWineInfo(text, rating.wine_name, rating.winery_name);
  } catch {
    return {};
  }
}

function extractWineInfo(
  text: string,
  wineName: string,
  wineryName: string
): Partial<VivinoWineDetails> {
  const result: Partial<VivinoWineDetails> = {};

  // Extract grape varieties — rank by frequency and name match
  const grapes = COMMON_GRAPES.filter(g => new RegExp(`\\b${g}\\b`, 'i').test(text));
  if (grapes.length) {
    const ranked = grapes.sort((a, b) => {
      const inNameA = wineName.toLowerCase().includes(a.toLowerCase()) || wineryName.toLowerCase().includes(a.toLowerCase());
      const inNameB = wineName.toLowerCase().includes(b.toLowerCase()) || wineryName.toLowerCase().includes(b.toLowerCase());
      const countA = (text.match(new RegExp(a, 'gi')) ?? []).length;
      const countB = (text.match(new RegExp(b, 'gi')) ?? []).length;
      return ((inNameB ? 10 : 0) + countB) - ((inNameA ? 10 : 0) + countA);
    });
    result.grape_varieties = ranked.slice(0, 4);
  }

  // Extract country
  for (const [pattern, name] of Object.entries(KNOWN_COUNTRIES)) {
    if (new RegExp(`\\b${pattern}\\b`, 'i').test(text)) {
      result.country = name;
      break;
    }
  }

  // Extract region — try each known region, pick the one appearing most
  const regionHits = KNOWN_REGIONS.filter(r => new RegExp(`\\b${r}\\b`, 'i').test(text));
  if (regionHits.length) {
    result.region = regionHits.sort((a, b) =>
      (text.match(new RegExp(b, 'gi')) ?? []).length - (text.match(new RegExp(a, 'gi')) ?? []).length
    )[0];
  }

  return result;
}
