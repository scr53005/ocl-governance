// src/app/api/projections/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export interface ProjectionRow {
  id: string;
  date: string;      // ISO date string (YYYY-MM-DD)
  hbdAmount: number;  // positive = income, negative = spending
  reason: string;
}

const KV_KEY = 'projections';

async function getProjections(): Promise<ProjectionRow[]> {
  return (await redis.get<ProjectionRow[]>(KV_KEY)) ?? [];
}

export async function GET() {
  try {
    const rows = await getProjections();
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Projections fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch projections' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { date, hbdAmount, reason } = await request.json();

    if (!date || typeof hbdAmount !== 'number' || !reason) {
      return NextResponse.json(
        { error: 'Missing required fields: date, hbdAmount, reason' },
        { status: 400 }
      );
    }

    const rows = await getProjections();
    const newRow: ProjectionRow = {
      id: crypto.randomUUID(),
      date,
      hbdAmount,
      reason,
    };
    rows.push(newRow);
    rows.sort((a, b) => a.date.localeCompare(b.date));
    await redis.set(KV_KEY, rows);

    return NextResponse.json(rows);
  } catch (error) {
    console.error('Projections POST error:', error);
    return NextResponse.json({ error: 'Failed to add projection' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    let rows = await getProjections();
    rows = rows.filter((r) => r.id !== id);
    await redis.set(KV_KEY, rows);

    return NextResponse.json(rows);
  } catch (error) {
    console.error('Projections DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete projection' }, { status: 500 });
  }
}
