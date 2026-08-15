/**
 * Hotel and benefit catalog sync from the WhataHotel API.
 *
 * The `hotel`, `search` and `cityrates` methods all return the same hotel
 * record shape, including the `perks` array — the preferred-partner inclusions
 * that are the input to factor F6 (Effective Value). Those perks are the
 * differentiator the proposal named, and this is where they enter the system.
 */

import { db, withTransaction, type Queryable } from '@wahpi/data';

import { parseHotel, parseMoney, type ParsedHotel } from './parse.js';
import type { WahClient } from './client.js';
import type { WahHotelsResponse } from './types.js';

export interface CatalogSyncResult {
  readonly hotelsSeen: number;
  readonly hotelsWritten: number;
  readonly benefitsWritten: number;
  readonly destinationsWritten: number;
  readonly skipped: ReadonlyArray<{ hotelId: string; reason: string }>;
}

export async function syncHotelsFromSearch(
  client: WahClient,
  searchTerm: string,
  q?: Queryable,
): Promise<CatalogSyncResult> {
  const data = await client.call<WahHotelsResponse>('search', { hotelSearch: searchTerm });
  return persistHotels(data.hotels ?? [], q);
}

export async function syncHotelsFromCity(
  client: WahClient,
  city: string,
  checkIn: string,
  checkOut: string,
  guests = 2,
  q?: Queryable,
): Promise<CatalogSyncResult> {
  const data = await client.call<WahHotelsResponse>('cityrates', {
    city,
    guests,
    checkIn,
    checkOut,
  });
  return persistHotels(data.hotels ?? [], q, data.city?.name ?? city);
}

export async function syncHotelById(
  client: WahClient,
  wahHotelId: string,
  q?: Queryable,
): Promise<CatalogSyncResult> {
  const data = await client.call<WahHotelsResponse>('hotel', { hotel: wahHotelId });
  return persistHotels(data.hotels ?? [], q);
}

async function persistHotels(
  raw: readonly Parameters<typeof parseHotel>[0][],
  q?: Queryable,
  cityHint?: string,
): Promise<CatalogSyncResult> {
  const parsed: ParsedHotel[] = [];
  const skipped: Array<{ hotelId: string; reason: string }> = [];

  for (const record of raw) {
    const hotel = parseHotel(record);
    if (!hotel) {
      skipped.push({ hotelId: String(record?.hotelID ?? '?'), reason: 'MISSING_ID_OR_NAME' });
      continue;
    }
    parsed.push(hotel);
  }

  let hotelsWritten = 0;
  let benefitsWritten = 0;
  const destinations = new Set<string>();

  await withTransaction(async (client) => {
    const runner = (q ?? client) as Queryable;

    for (const hotel of parsed) {
      const cityName = hotel.city ?? cityHint ?? null;
      let destinationId: number | null = null;

      if (cityName) {
        const slug = slugify(cityName);
        const { rows } = await runner.query(
          `INSERT INTO destination (slug, name, country_code)
           VALUES ($1,$2,$3)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [slug, cityName, countryCode(hotel.country)],
        );
        destinationId = rows[0]?.id as number;
        destinations.add(slug);
      }

      const { rows: hotelRows } = await runner.query(
        `INSERT INTO hotel (wah_hotel_id, name, destination_id, latitude, longitude,
                            base_currency, collection_tier)
         VALUES ($1,$2,$3,$4,$5,'USD','WARM')
         ON CONFLICT (wah_hotel_id) DO UPDATE
           SET name = EXCLUDED.name,
               destination_id = COALESCE(EXCLUDED.destination_id, hotel.destination_id),
               latitude = COALESCE(EXCLUDED.latitude, hotel.latitude),
               longitude = COALESCE(EXCLUDED.longitude, hotel.longitude),
               updated_at = now()
         RETURNING id`,
        [hotel.wahHotelId, hotel.name, destinationId, hotel.latitude, hotel.longitude],
      );
      const hotelId = hotelRows[0]?.id as number;
      hotelsWritten += 1;

      // Perks → hotel_benefit. Only benefits already in the catalog are linked;
      // an unrecognised perk is left out rather than invented, because a
      // mis-valued benefit moves the Effective Value factor directly.
      for (const perk of hotel.perks) {
        const { rowCount } = await runner.query(
          `INSERT INTO hotel_benefit (hotel_id, benefit_id, value_minor, currency)
           SELECT $1, b.id, COALESCE($3, b.default_value_minor), 'USD'
             FROM benefit b WHERE b.code = $2
           ON CONFLICT (hotel_id, benefit_id) DO UPDATE
             SET value_minor = COALESCE(EXCLUDED.value_minor, hotel_benefit.value_minor)`,
          [hotelId, perk.benefitCode, perk.valueMinor],
        );
        benefitsWritten += rowCount ?? 0;
      }
    }
  }, undefined);

  return {
    hotelsSeen: raw.length,
    hotelsWritten,
    benefitsWritten,
    destinationsWritten: destinations.size,
    skipped,
  };
}

/** Starting nightly rate per hotel from `cityrates` — the comp-set seed. */
export async function cityStartingRates(
  client: WahClient,
  city: string,
  checkIn: string,
  checkOut: string,
  guests = 2,
): Promise<Array<{ wahHotelId: string; name: string; nightlyMinor: number; currency: string }>> {
  const data = await client.call<WahHotelsResponse>('cityrates', {
    city,
    guests,
    checkIn,
    checkOut,
  });

  const out: Array<{ wahHotelId: string; name: string; nightlyMinor: number; currency: string }> =
    [];
  for (const hotel of data.hotels ?? []) {
    // On this method the currency is embedded in the string ("522.75 USD")
    // rather than supplied in a sibling field, unlike the rates method.
    const money = parseMoney(hotel.rateDaily, 'USD');
    if (!money) continue;
    out.push({
      wahHotelId: hotel.hotelID,
      name: hotel.name,
      nightlyMinor: money.amountMinor,
      currency: money.currency ?? 'USD',
    });
  }
  return out;
}

export async function ensureWhataHotelSource(code: string, q?: Queryable): Promise<number> {
  const { rows } = await db(q).query(
    `INSERT INTO source (code, display_name, is_authoritative, trust_weight)
     VALUES ($1, 'WhataHotel data API', true, 1.00)
     ON CONFLICT (code) DO UPDATE SET is_authoritative = true
     RETURNING id`,
    [code],
  );
  return rows[0]?.id as number;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function countryCode(country: string | null): string | null {
  if (!country) return null;
  const map: Record<string, string> = {
    'united states': 'US',
    'united kingdom': 'GB',
    france: 'FR',
    italy: 'IT',
    spain: 'ES',
    mexico: 'MX',
    canada: 'CA',
  };
  return map[country.toLowerCase()] ?? null;
}
