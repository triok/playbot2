import { Opportunity } from '../types';
import { v4 as uuidv4 } from 'uuid';

// Points to our local Node.js server
const BACKEND_URL = '/api/opportunities';

/**
 * Fetches opportunities from the local Node.js backend.
 * The backend handles the complex logic and external API communication.
 */
export const scanForOpportunities = async (
  minPrice: number = 0.90,
  maxTimeHours: number = 48
): Promise<Opportunity[]> => {
  try {
    const params = new URLSearchParams({
      minPrice: minPrice.toString(),
      maxTimeHours: maxTimeHours.toString(),
    });
    
    // We now fetch from our own server, avoiding CORS issues
    const response = await fetch(`${BACKEND_URL}?${params.toString()}`);
    // console.log(response);
    if (!response.ok) {
      // Handle case where server is down or returns 500
      const errorText = await response.text();
      throw new Error(errorText || `Server Error: ${response.status}`);
    }



    const raw: Opportunity[] = await response.json();

    // добавляем уникальные ключи
    const opportunities = raw.map(o => ({
      ...o,
      uuid: uuidv4()
    }));

    return opportunities;

  } catch (error) {
    console.error("Failed to connect to backend bot server", error);
    // Provide a clear error message to the UI
    if ((error as TypeError).message.includes('Failed to fetch')) {
        throw new Error("Backend server is offline. Run 'node server.js' in terminal.");
    }
    throw error;
  }
};

