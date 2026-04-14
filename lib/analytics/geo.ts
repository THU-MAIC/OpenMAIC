/**
 * Geolocation utility for mapping country codes to names
 * and extracting country information from request headers.
 */

// Basic mapping of country codes to human names
export const COUNTRY_NAMES: Record<string, string> = {
  'US': 'United States',
  'IN': 'India',
  'GB': 'United Kingdom',
  'CA': 'Canada',
  'AU': 'Australia',
  'DE': 'Germany',
  'FR': 'France',
  'JP': 'Japan',
  'CN': 'China',
  'BR': 'Brazil',
  'RU': 'Russia',
  'MX': 'Mexico',
  'ID': 'Indonesia',
  'PK': 'Pakistan',
  'NG': 'Nigeria',
  'BD': 'Bangladesh',
  'RU': 'Russia',
  'JP': 'Japan',
  'MX': 'Mexico',
  'PH': 'Philippines',
  'VN': 'Vietnam',
  'ET': 'Ethiopia',
  'EG': 'Egypt',
  'IR': 'Iran',
  'TR': 'Turkey',
  'TH': 'Thailand',
  'FR': 'France',
  'GB': 'United Kingdom',
  'IT': 'Italy',
  'ZA': 'South Africa',
  'ES': 'Spain',
  'CO': 'Colombia',
  'AR': 'Argentina',
  'DZ': 'Algeria',
  'SD': 'Sudan',
  'UA': 'Ukraine',
  'IQ': 'Iraq',
  'PL': 'Poland',
  'CA': 'Canada',
  'AF': 'Afghanistan',
  'MA': 'Morocco',
  'SA': 'Saudi Arabia',
  'UZ': 'Uzbekistan',
  'PE': 'Peru',
  'MY': 'Malaysia',
  'AO': 'Angola',
  'GH': 'Ghana',
  'MZ': 'Mozambique',
  'YE': 'Yemen',
  'NP': 'Nepal',
  'VE': 'Venezuela',
  'MG': 'Madagascar',
  'CM': 'Cameroon',
  'CI': 'Ivory Coast',
  'KP': 'North Korea',
  'AU': 'Australia',
  'NE': 'Niger',
  'TW': 'Taiwan',
  'LK': 'Sri Lanka',
  'BF': 'Burkina Faso',
  'ML': 'Mali',
  'RO': 'Romania',
  'MW': 'Malawi',
  'CL': 'Chile',
  'KZ': 'Kazakhstan',
  'ZM': 'Zambia',
  'GT': 'Guatemala',
  'EC': 'Ecuador',
  'SY': 'Syria',
  'SN': 'Senegal',
  'KH': 'Cambodia',
  'TD': 'Chad',
  'SO': 'Somalia',
  'ZW': 'Zimbabwe',
  'GN': 'Guinea',
  'RW': 'Rwanda',
  'BJ': 'Benin',
  'BI': 'Burundi',
  'TN': 'Tunisia',
  'SS': 'South Sudan',
  'HT': 'Haiti',
  'BE': 'Belgium',
  'CU': 'Cuba',
  'JO': 'Jordan',
  'GR': 'Greece',
  'CZ': 'Czech Republic',
  'PT': 'Portugal',
  'SE': 'Sweden',
  'AZ': 'Azerbaijan',
  'HU': 'Hungary',
  'AE': 'United Arab Emirates',
  'BY': 'Belarus',
  'IL': 'Israel',
  'CH': 'Switzerland',
  'AT': 'Austria',
  'HK': 'Hong Kong',
  'RS': 'Serbia',
  'SG': 'Singapore',
  'DK': 'Denmark',
  'FI': 'Finland',
  'NO': 'Norway',
  'NZ': 'New Zealand',
  'IE': 'Ireland',
  'KW': 'Kuwait',
  'QA': 'Qatar',
  // Add more as needed...
};

export interface GeoInfo {
  countryCode: string;
  countryName: string;
}

/**
 * Extracts country info from common cloud provider headers
 */
export function getGeoInfo(headers: Headers): GeoInfo {
  // Vercel
  const vercelCountry = headers.get('x-vercel-ip-country');
  if (vercelCountry) {
    return {
      countryCode: vercelCountry.toUpperCase(),
      countryName: COUNTRY_NAMES[vercelCountry.toUpperCase()] || 'Unknown Country'
    };
  }

  // Cloudflare
  const cfCountry = headers.get('cf-ipcountry');
  if (cfCountry && cfCountry !== 'XX') {
    return {
      countryCode: cfCountry.toUpperCase(),
      countryName: COUNTRY_NAMES[cfCountry.toUpperCase()] || 'Unknown Country'
    };
  }

  // Fallback for local dev or missing headers
  return {
    countryCode: 'XX',
    countryName: 'Unknown'
  };
}
