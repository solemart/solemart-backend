require('dotenv').config();
const bcrypt = require('bcryptjs');
const db     = require('../config/db');

const seed = async () => {
  console.log('🌱 Seeding SoleMart database...');

  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'solemart_admin', 12);

  // Admin user
  await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified)
    VALUES ('Admin', 'User', $1, $2, 'admin', TRUE)
    ON CONFLICT (email) DO NOTHING
  `, [process.env.ADMIN_EMAIL || 'admin@solemart.co.uk', hash]);

  // Staff user
  const staffHash = await bcrypt.hash('solemart_staff', 12);
  await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified)
    VALUES ('Alex', 'Lawson', 'alex@solemart.co.uk', $1, 'staff', TRUE)
    ON CONFLICT (email) DO NOTHING
  `, [staffHash]);

  // Demo customer
  const custHash = await bcrypt.hash('password123', 12);
  const { rows: custRows } = await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified,
                       addr_line1, addr_city, addr_postcode, shoe_size)
    VALUES ('Jane', 'Smith', 'jane@example.com', $1, 'customer', TRUE,
            '1 High Street', 'London', 'SW1A 1AA', '7')
    ON CONFLICT (email) DO NOTHING
    RETURNING id
  `, [custHash]);

  // Demo owner
  const ownerHash = await bcrypt.hash('password123', 12);
  const { rows: ownerRows } = await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified,
                       addr_line1, addr_city, addr_postcode)
    VALUES ('Mike', 'Stephens', 'mike@example.com', $1, 'owner', TRUE,
            '22 Brick Lane', 'London', 'E1 6RF')
    ON CONFLICT (email) DO NOTHING
    RETURNING id
  `, [ownerHash]);

  if (ownerRows.length) {
    const ownerId = ownerRows[0].id;

    // Seed demo shoes
    const shoes = [
      { brand: 'Nike', model: 'Air Max 90', size: '9', colour: 'White/Red', category: 'Sneaker',
        listing_type: 'both', rent_price: 8, buy_price: 120, condition: 'Like New',
        emoji: '👟', auth_score: 96, auth_grade: 'A', status: 'listed',
        description: 'Classic Air Max 90 in pristine condition.' },
      { brand: 'Adidas', model: 'Samba OG', size: '8', colour: 'White/Black/Gum', category: 'Sneaker',
        listing_type: 'both', rent_price: 7, buy_price: 95, condition: 'Very Good',
        emoji: '👟', auth_score: 94, auth_grade: 'A', status: 'listed',
        description: 'The Samba OG in its most classic colourway.' },
      { brand: 'Bottega Veneta', model: 'Puddle Boot', size: '6', colour: 'Black', category: 'Boots',
        listing_type: 'rent', rent_price: 22, buy_price: null, condition: 'Like New',
        emoji: '👢', auth_score: 99, auth_grade: 'A+', status: 'listed',
        description: 'Bottega iconic puddle boot in glossy black.' },
      { brand: 'Manolo Blahnik', model: 'Hangisi 105', size: '5', colour: 'Ivory', category: 'Heels',
        listing_type: 'rent', rent_price: 35, buy_price: null, condition: 'Like New',
        emoji: '👠', auth_score: 100, auth_grade: 'A+', status: 'listed',
        description: 'The jewel-buckle Hangisi in ivory satin.' },
    ];

    for (const shoe of shoes) {
      await db.query(`
        INSERT INTO shoes
          (owner_id, brand, model, size, colour, category, listing_type,
           rent_price, buy_price, condition, emoji, auth_score, auth_grade,
           status, listed_at, description,
           rental_count, clean_count, listing_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16,$17,$18)
        ON CONFLICT DO NOTHING
      `, [
        ownerId, shoe.brand, shoe.model, shoe.size, shoe.colour, shoe.category,
        shoe.listing_type, shoe.rent_price, shoe.buy_price, shoe.condition,
        shoe.emoji, shoe.auth_score, shoe.auth_grade, shoe.status, shoe.description,
        Math.floor(Math.random() * 8),
        Math.floor(Math.random() * 8) + 1,
        Math.floor(Math.random() * 5) + 1,
      ]);
    }
  }

  console.log('✅ Seed complete.');
  console.log('   Admin:    admin@solemart.co.uk / (see ADMIN_PASSWORD in .env)');
  console.log('   Staff:    alex@solemart.co.uk  / solemart_staff');
  console.log('   Customer: jane@example.com     / password123');
  console.log('   Owner:    mike@example.com     / password123');
  process.exit(0);
};

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
