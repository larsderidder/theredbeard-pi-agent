/**
 * SearXNG Web Search Extension
 * 
 * Self-hosted metasearch API with unlimited searches.
 * Aggregates results from Google, Bing, DuckDuckGo, Brave, and more.
 * 
 * Usage:
 * 1. This file is auto-loaded from ~/.pi/agent/extensions/
 * 2. Use web_search tool in any conversation
 * 
 * Backend: set SEARXNG_URL env var to your self-hosted SearXNG instance
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as https from "https";
import * as http from "http";

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8080';

interface SearchResult {
    title: string;
    url: string;
    content: string;
    engine: string;
    score: number;
    publishedDate?: string;
}

interface SearchResponse {
    query: string;
    results: SearchResult[];
    number_of_results: number;
    suggestions: string[];
    infoboxes: any[];
}

/**
 * Perform web search using SearXNG
 */
async function performSearch(
    query: string,
    count: number = 10,
    freshness?: string,
    language: string = 'en',
    safesearch: string = 'off'
): Promise<SearchResponse> {
    const params = new URLSearchParams({
        q: query,
        format: 'json',
        language: language
    });

    // Map safesearch levels
    const safesearchMap: { [key: string]: string } = {
        'off': '0',
        'moderate': '1',
        'strict': '2'
    };
    params.append('safesearch', safesearchMap[safesearch] || '0');

    // Add time filter if specified
    if (freshness) {
        // Map common Brave API values to SearXNG
        const timeRangeMap: { [key: string]: string } = {
            'pd': 'day',
            'pw': 'week',
            'pm': 'month',
            'py': 'year',
            'day': 'day',
            'week': 'week',
            'month': 'month',
            'year': 'year'
        };
        const timeRange = timeRangeMap[freshness] || freshness;
        params.append('time_range', timeRange);
    }

    const url = `${SEARXNG_URL}/search?${params.toString()}`;

    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const req = protocol.get(url, { timeout: 10000 }, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    
                    // Normalize response
                    const results: SearchResult[] = (json.results || []).slice(0, count).map((r: any) => ({
                        title: r.title || '',
                        url: r.url || '',
                        content: r.content || '',
                        engine: r.engine || 'unknown',
                        score: r.score || 0,
                        publishedDate: r.publishedDate || undefined
                    }));

                    resolve({
                        query: json.query || query,
                        results: results,
                        number_of_results: json.number_of_results || 0,
                        suggestions: json.suggestions || [],
                        infoboxes: json.infoboxes || []
                    });
                } catch (error: any) {
                    reject(new Error(`Failed to parse SearXNG response: ${error.message}`));
                }
            });
        });

        req.on('error', (error: any) => {
            reject(new Error(`SearXNG request failed: ${error.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('SearXNG request timed out'));
        });
    });
}

export default function searxngExtension(pi: ExtensionAPI) {
    // Register web_search tool
    pi.registerTool({
        name: 'web_search',
        label: 'Web Search (SearXNG)',
        description: 'Search the web using SearXNG. Aggregates results from Google, Bing, DuckDuckGo, Brave, and more. No rate limits.',
        parameters: Type.Object({
            query: Type.String({ description: 'Search query' }),
            count: Type.Optional(Type.Number({ 
                description: 'Number of results to return (default: 10, max: 20)',
                default: 10,
                minimum: 1,
                maximum: 20
            })),
            freshness: Type.Optional(Type.String({ 
                description: 'Time filter: "day", "week", "month", "year", or Brave API format "pd", "pw", "pm", "py"',
                enum: ['day', 'week', 'month', 'year', 'pd', 'pw', 'pm', 'py']
            })),
            language: Type.Optional(Type.String({ 
                description: 'Result language (e.g., "en", "nl", "de")',
                default: 'en'
            })),
            safesearch: Type.Optional(Type.String({ 
                description: 'Safe search level',
                enum: ['off', 'moderate', 'strict'],
                default: 'off'
            }))
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            try {
                const result = await performSearch(
                    params.query,
                    params.count || 10,
                    params.freshness,
                    params.language || 'en',
                    params.safesearch || 'off'
                );

                // Format results for display
                const resultText = result.results.map((r, i) => 
                    `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content.substring(0, 150)}...`
                ).join('\n\n');

                const summary = `Found ${result.results.length} results for "${result.query}"\n` +
                    `Engines: ${[...new Set(result.results.map(r => r.engine))].join(', ')}\n\n` +
                    resultText;

                return {
                    content: [{ 
                        type: 'text', 
                        text: summary 
                    }],
                    details: {
                        query: result.query,
                        results: result.results,
                        total: result.number_of_results,
                        suggestions: result.suggestions
                    }
                };
            } catch (error: any) {
                return {
                    content: [{ 
                        type: 'text', 
                        text: `Search failed: ${error.message}` 
                    }],
                    details: { error: error.message }
                };
            }
        }
    });

    // Notify on load
    pi.on('session_start', async (_event, ctx) => {
        // Silent load - no notification needed
    });
}
