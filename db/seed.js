require('dotenv').config();
const bcrypt = require('bcryptjs');
const db     = require('../config/db');

const seed = async () => {
  console.log('🌱 Seeding Kosmos database...');

  const rounds = 12;
  const pw123  = await bcrypt.hash('password123', rounds);

  // ── ADMIN & STAFF ──────────────────────────────────────────────────────────
  const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'change_me_immediately', rounds);
  await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified)
    VALUES ('Admin', 'User', 'admin@kosmos.co.uk', $1, 'admin', TRUE)
    ON CONFLICT (email) DO UPDATE SET password_hash = $1
  `, [adminHash]);

  const staffHash = await bcrypt.hash('kosmos_staff', rounds);
  await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified)
    VALUES ('Alex', 'Lawson', 'alex@kosmos.co.uk', $1, 'staff', TRUE)
    ON CONFLICT (email) DO NOTHING
  `, [staffHash]);

  // ── CUSTOMERS ──────────────────────────────────────────────────────────────
  await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified, addr_line1, addr_city, addr_postcode, shoe_size)
    VALUES ('Jane', 'Smith', 'jane@example.com', $1, 'customer', TRUE, '1 High Street', 'London', 'SW1A 1AA', '7')
    ON CONFLICT (email) DO NOTHING
  `, [pw123]);

  await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified, addr_line1, addr_city, addr_postcode, shoe_size)
    VALUES ('Priya', 'Patel', 'priya@example.com', $1, 'customer', TRUE, '14 Victoria Road', 'Manchester', 'M1 4BT', '5.5')
    ON CONFLICT (email) DO NOTHING
  `, [pw123]);

  // ── OWNERS ─────────────────────────────────────────────────────────────────
  const { rows: mikeRows } = await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified, addr_line1, addr_city, addr_postcode)
    VALUES ('Mike', 'Stephens', 'mike@example.com', $1, 'owner', TRUE, '22 Brick Lane', 'London', 'E1 6RF')
    ON CONFLICT (email) DO UPDATE SET role = 'owner' RETURNING id
  `, [pw123]);

  const { rows: sophieRows } = await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified, addr_line1, addr_city, addr_postcode)
    VALUES ('Sophie', 'Clarke', 'sophie@example.com', $1, 'owner', TRUE, '8 Camden High Street', 'London', 'NW1 8QH')
    ON CONFLICT (email) DO UPDATE SET role = 'owner' RETURNING id
  `, [pw123]);

  const { rows: jamesRows } = await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified, addr_line1, addr_city, addr_postcode)
    VALUES ('James', 'Okafor', 'james@example.com', $1, 'owner', TRUE, '3 Portobello Road', 'London', 'W11 2DA')
    ON CONFLICT (email) DO UPDATE SET role = 'owner' RETURNING id
  `, [pw123]);

  const { rows: amaraRows } = await db.query(`
    INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified, addr_line1, addr_city, addr_postcode)
    VALUES ('Amara', 'Diallo', 'amara@example.com', $1, 'owner', TRUE, '55 Shoreditch High St', 'London', 'E1 6JJ')
    ON CONFLICT (email) DO UPDATE SET role = 'owner' RETURNING id
  `, [pw123]);

  const mikeId  = mikeRows[0]?.id;
  const sophieId = sophieRows[0]?.id;
  const jamesId  = jamesRows[0]?.id;
  const amaraId  = amaraRows[0]?.id;

  if (!mikeId) {
    console.log('Owners already exist, skipping shoe seed. Run with fresh DB to re-seed.');
    process.exit(0);
  }

  const insertShoe = async (ownerId, s) => {
    await db.query(`
      INSERT INTO shoes
        (owner_id, brand, model, size, colour, category, gender, listing_type,
         rrp, rent_price, buy_price, condition, emoji, auth_score, auth_grade,
         assessed_wear_grade, is_pre_loved, status, listed_at, description,
         rental_count, clean_count, listing_count, donation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
              NOW() - ($19 || ' days')::interval,$20,$21,$22,$23,$24)
      ON CONFLICT DO NOTHING
    `, [
      ownerId, s.brand, s.model, s.size, s.colour || 'Mixed',
      s.category, s.gender || null, s.listing_type,
      s.rrp || null, s.rent_price, s.buy_price || null,
      s.condition, s.emoji, s.auth_score, s.auth_grade,
      s.assessed_wear_grade || null, s.is_pre_loved || false,
      s.status || 'listed', String(s.days_ago || 0),
      s.description, s.rental_count || 0, s.clean_count || 0,
      s.listing_count || 1, s.donation_id || null,
    ]);
  };

  // ── MIKE (original owner) ──────────────────────────────────────────────────
  await insertShoe(mikeId, { brand:'Nike', model:'Air Max 90', size:'9', colour:'White/Red', category:'Sneaker', listing_type:'both', rrp:140, rent_price:3.00, buy_price:98, condition:'Brand New', emoji:'👟', auth_score:99, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:60, rental_count:0, clean_count:1, listing_count:1, description:'Classic Air Max 90 in pristine condition. Deadstock box included.' });
  await insertShoe(mikeId, { brand:'Adidas', model:'Samba OG', size:'8', colour:'White/Black/Gum', category:'Sneaker', listing_type:'both', rrp:100, rent_price:2.14, buy_price:45, condition:'Good', emoji:'👟', auth_score:88, auth_grade:'A', assessed_wear_grade:'Good', status:'listed', days_ago:120, rental_count:6, clean_count:7, listing_count:4, description:'The iconic Samba OG. Well loved and beautifully broken in.' });
  await insertShoe(mikeId, { brand:'Bottega Veneta', model:'Puddle Boot', size:'6', colour:'Black', category:'Boots', listing_type:'rent', rrp:850, rent_price:18.21, buy_price:null, condition:'Like New', emoji:'👢', auth_score:99, auth_grade:'A+', assessed_wear_grade:'Excellent', status:'listed', days_ago:45, rental_count:2, clean_count:3, listing_count:2, description:'Bottega iconic puddle boot in glossy black.' });
  await insertShoe(mikeId, { brand:'Manolo Blahnik', model:'Hangisi 105', size:'5', colour:'Ivory', category:'Heels', listing_type:'rent', rrp:1100, rent_price:23.57, buy_price:null, condition:'Like New', emoji:'👠', auth_score:100, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:30, rental_count:0, clean_count:1, listing_count:1, description:'The jewel-buckle Hangisi in ivory satin.' });
  await insertShoe(mikeId, { brand:'Air Jordan', model:'1 Retro High OG Chicago', size:'10', colour:'Chicago', category:'Sneaker', listing_type:'both', rrp:180, rent_price:1.54, buy_price:29, condition:'Fair', emoji:'👟', auth_score:80, auth_grade:'B+', assessed_wear_grade:'Fair', status:'listed', days_ago:180, rental_count:12, clean_count:13, listing_count:6, description:'The Chicago colourway. Heavily worn — character in every crease.' });
  await insertShoe(mikeId, { brand:'New Balance', model:'550', size:'9', colour:'White/Green', category:'Sneaker', listing_type:'both', rrp:110, rent_price:2.36, buy_price:77, condition:'Brand New', emoji:'👟', auth_score:98, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:14, rental_count:0, clean_count:1, listing_count:1, description:'Fresh 550s. Clean court aesthetic, never worn.' });
  await insertShoe(mikeId, { brand:'On Running', model:'Cloudmonster', size:'9', colour:'Glacier/White', category:'Sneaker', listing_type:'both', rrp:170, rent_price:3.64, buy_price:119, condition:'Brand New', emoji:'👟', auth_score:99, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:6, rental_count:0, clean_count:1, listing_count:1, description:'On Cloudmonster in Glacier. Maximum cushion, never worn.' });
  await insertShoe(mikeId, { brand:'Hoka', model:'Clifton 9', size:'9.5', colour:'Black/White', category:'Sneaker', listing_type:'both', rrp:140, rent_price:2.86, buy_price:91, condition:'Like New', emoji:'👟', auth_score:94, auth_grade:'A', assessed_wear_grade:'Excellent', status:'listed', days_ago:42, rental_count:2, clean_count:3, listing_count:2, description:'Hoka Clifton 9. Maximum cushion for maximum comfort.' });

  // ── SOPHIE (luxury womenswear) ─────────────────────────────────────────────
  await insertShoe(sophieId, { brand:'Christian Louboutin', model:'So Kate 120', size:'4', colour:'Nude', category:'Heels', gender:'Women', listing_type:'rent', rrp:595, rent_price:12.75, buy_price:null, condition:'Like New', emoji:'👠', auth_score:97, auth_grade:'A+', assessed_wear_grade:'Excellent', status:'listed', days_ago:50, rental_count:3, clean_count:4, listing_count:2, description:'The iconic So Kate in nude. Perfect for events.' });
  await insertShoe(sophieId, { brand:'Jimmy Choo', model:'Romy 60', size:'5', colour:'Black Suede', category:'Heels', gender:'Women', listing_type:'both', rrp:495, rent_price:10.61, buy_price:346, condition:'Brand New', emoji:'👠', auth_score:100, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:7, rental_count:0, clean_count:1, listing_count:1, description:'Romy 60 in black suede. Classic Jimmy Choo, never worn.' });
  await insertShoe(sophieId, { brand:'Prada', model:'Monolith Derby', size:'6', colour:'Black', category:'Dress', gender:'Women', listing_type:'both', rrp:850, rent_price:18.21, buy_price:595, condition:'Brand New', emoji:'👞', auth_score:99, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:20, rental_count:0, clean_count:1, listing_count:1, description:'Prada Monolith Derby. The chunky sole statement shoe.' });
  await insertShoe(sophieId, { brand:'Gucci', model:'Princetown Mule', size:'5.5', colour:'Black Leather', category:'Flats', gender:'Women', listing_type:'both', rrp:620, rent_price:8.08, buy_price:174, condition:'Very Good', emoji:'🥿', auth_score:91, auth_grade:'A', assessed_wear_grade:'Good', status:'listed', days_ago:100, rental_count:7, clean_count:8, listing_count:4, description:'Gucci Princetown in black leather with horse-bit.' });
  await insertShoe(sophieId, { brand:'Miu Miu', model:'Wander Mule', size:'4.5', colour:'Cream', category:'Flats', gender:'Women', listing_type:'rent', rrp:720, rent_price:15.43, buy_price:null, condition:'Like New', emoji:'🥿', auth_score:96, auth_grade:'A+', assessed_wear_grade:'Excellent', status:'listed', days_ago:35, rental_count:2, clean_count:3, listing_count:2, description:'The Wander mule by Miu Miu. Understated luxury.' });
  await insertShoe(sophieId, { brand:'Valentino', model:'Rockstud Pump', size:'5', colour:'Blush', category:'Heels', gender:'Women', listing_type:'both', rrp:750, rent_price:2.41, buy_price:30, condition:'Fair', emoji:'👠', auth_score:78, auth_grade:'B+', assessed_wear_grade:'Vintage', status:'listed', days_ago:300, rental_count:19, clean_count:20, listing_count:9, description:'The original Rockstud. Vintage grade — well travelled.' });
  await insertShoe(sophieId, { brand:'Acne Studios', model:'Musubi Sandal', size:'5', colour:'Tan', category:'Sandals', gender:'Women', listing_type:'both', rrp:380, rent_price:8.14, buy_price:266, condition:'Brand New', emoji:'👡', auth_score:98, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:10, rental_count:0, clean_count:1, listing_count:1, description:'Acne Studios Musubi sandal. Sculptural knot detail.' });
  await insertShoe(sophieId, { brand:'Roger Vivier', model:'Prismick Sneaker', size:'6', colour:'White', category:'Sneaker', gender:'Women', listing_type:'both', rrp:680, rent_price:9.71, buy_price:306, condition:'Very Good', emoji:'👟', auth_score:93, auth_grade:'A', assessed_wear_grade:'Good', status:'listed', days_ago:90, rental_count:5, clean_count:6, listing_count:3, description:'Roger Vivier Prismick sneaker with signature Buckle.' });
  await insertShoe(sophieId, { brand:'Loewe', model:'Terra Sandal', size:'5.5', colour:'Tan', category:'Sandals', gender:'Women', listing_type:'rent', rrp:560, rent_price:12.00, buy_price:null, condition:'Like New', emoji:'👡', auth_score:95, auth_grade:'A+', assessed_wear_grade:'Excellent', status:'listed', days_ago:55, rental_count:2, clean_count:3, listing_count:2, description:'Loewe Terra sandal. Architectural heel, minimal design.' });
  await insertShoe(sophieId, { brand:'Isabel Marant', model:'Balskee Wedge Sneaker', size:'5', colour:'Ecru', category:'Sneaker', gender:'Women', listing_type:'both', rrp:430, rent_price:5.57, buy_price:193, condition:'Very Good', emoji:'👟', auth_score:90, auth_grade:'A', assessed_wear_grade:'Good', status:'listed', days_ago:88, rental_count:5, clean_count:6, listing_count:3, description:'Isabel Marant Balskee wedge sneaker. The French designer lift.' });

  // ── JAMES (streetwear/menswear) ────────────────────────────────────────────
  await insertShoe(jamesId, { brand:'Nike', model:'Dunk Low Retro', size:'10', colour:'Panda', category:'Sneaker', gender:'Men', listing_type:'both', rrp:100, rent_price:2.14, buy_price:70, condition:'Brand New', emoji:'👟', auth_score:99, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:5, rental_count:0, clean_count:1, listing_count:1, description:'The Panda Dunk. Deadstock, never laced.' });
  await insertShoe(jamesId, { brand:'Adidas', model:'Yeezy Boost 350 V2 Zebra', size:'9.5', colour:'Zebra', category:'Sneaker', gender:'Men', listing_type:'both', rrp:220, rent_price:4.71, buy_price:154, condition:'Brand New', emoji:'👟', auth_score:97, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:25, rental_count:0, clean_count:1, listing_count:1, description:'Zebra 350 V2. Authenticated by our team — 100% genuine.' });
  await insertShoe(jamesId, { brand:'New Balance', model:'990v3 Made in USA', size:'10', colour:'Grey', category:'Sneaker', gender:'Men', listing_type:'both', rrp:175, rent_price:2.81, buy_price:98, condition:'Very Good', emoji:'👟', auth_score:92, auth_grade:'A', assessed_wear_grade:'Good', status:'listed', days_ago:110, rental_count:5, clean_count:6, listing_count:3, description:'Made in USA 990v3. The daddy shoe in grey suede.' });
  await insertShoe(jamesId, { brand:'Salomon', model:'XT-6', size:'9', colour:'Black/Phantom', category:'Sneaker', gender:'Men', listing_type:'both', rrp:180, rent_price:3.86, buy_price:126, condition:'Brand New', emoji:'👟', auth_score:98, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:18, rental_count:0, clean_count:1, listing_count:1, description:'Trail-running aesthetic meets street. Salomon XT-6.' });
  await insertShoe(jamesId, { brand:'Stone Island', model:'S0101 Boot', size:'9', colour:'Olive', category:'Boots', gender:'Men', listing_type:'both', rrp:450, rent_price:6.43, buy_price:203, condition:'Good', emoji:'🥾', auth_score:87, auth_grade:'B+', assessed_wear_grade:'Good', status:'listed', days_ago:140, rental_count:6, clean_count:7, listing_count:4, description:'Stone Island S0101 combat boot. Functional and iconic.' });
  await insertShoe(jamesId, { brand:'Maison Margiela', model:'Replica Low', size:'9', colour:'White', category:'Sneaker', gender:'Men', listing_type:'both', rrp:480, rent_price:1.54, buy_price:22, condition:'Fair', emoji:'👟', auth_score:75, auth_grade:'B', assessed_wear_grade:'Vintage', status:'listed', days_ago:280, rental_count:18, clean_count:19, listing_count:8, description:'MM6 Replica. Well worn — the patina tells the story.' });
  await insertShoe(jamesId, { brand:'Asics', model:'Gel-Kayano 14', size:'10', colour:'Cream/Burgundy', category:'Sneaker', gender:'Men', listing_type:'both', rrp:130, rent_price:2.79, buy_price:91, condition:'Brand New', emoji:'👟', auth_score:98, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:8, rental_count:0, clean_count:1, listing_count:1, description:'The Y2K silhouette is back. Gel-Kayano 14 deadstock.' });
  await insertShoe(jamesId, { brand:'Clarks', model:'Desert Boot', size:'9.5', colour:'Sand Suede', category:'Boots', gender:'Men', listing_type:'both', rrp:120, rent_price:1.54, buy_price:28, condition:'Fair', emoji:'🥾', auth_score:79, auth_grade:'B+', assessed_wear_grade:'Fair', status:'listed', days_ago:200, rental_count:11, clean_count:12, listing_count:6, description:'The original desert boot. Crepe sole, beautifully aged.' });
  await insertShoe(jamesId, { brand:'Common Projects', model:'Achilles Low', size:'9', colour:'White', category:'Sneaker', gender:'Men', listing_type:'both', rrp:440, rent_price:9.43, buy_price:308, condition:'Brand New', emoji:'👟', auth_score:99, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:16, rental_count:0, clean_count:1, listing_count:1, description:'Common Projects Achilles Low. The minimalist sneaker.' });
  await insertShoe(jamesId, { brand:'Converse', model:'Run Star Motion Hi', size:'10', colour:'Black', category:'Sneaker', listing_type:'both', rrp:100, rent_price:1.07, buy_price:28, condition:'Good', emoji:'👟', auth_score:83, auth_grade:'A', assessed_wear_grade:'Good', status:'listed', days_ago:130, rental_count:6, clean_count:7, listing_count:4, description:'Run Star Motion with the platform sole. Chunky Chuck energy.' });

  // ── AMARA (heels, ballet, eclectic) ────────────────────────────────────────
  await insertShoe(amaraId, { brand:'Repetto', model:'Cendrillon Ballet Flat', size:'5', colour:'Rose', category:'Flats', gender:'Women', listing_type:'both', rrp:250, rent_price:5.36, buy_price:175, condition:'Brand New', emoji:'🩰', auth_score:99, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:12, rental_count:0, clean_count:1, listing_count:1, description:'The Cendrillon in rose. French ballet perfection.' });
  await insertShoe(amaraId, { brand:'Toteme', model:'T-Strap Sandal', size:'5.5', colour:'Tan', category:'Sandals', gender:'Women', listing_type:'rent', rrp:420, rent_price:9.00, buy_price:null, condition:'Like New', emoji:'👡', auth_score:95, auth_grade:'A+', assessed_wear_grade:'Excellent', status:'listed', days_ago:40, rental_count:3, clean_count:4, listing_count:2, description:'Toteme T-strap. Effortless Scandinavian minimalism.' });
  await insertShoe(amaraId, { brand:'The Row', model:'Gaia Flat', size:'6', colour:'Black', category:'Flats', gender:'Women', listing_type:'rent', rrp:890, rent_price:19.07, buy_price:null, condition:'Brand New', emoji:'🥿', auth_score:100, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:3, rental_count:0, clean_count:1, listing_count:1, description:'The Row Gaia. Quiet luxury at its purest.' });
  await insertShoe(amaraId, { brand:'Gianvito Rossi', model:'Portofino 85', size:'5', colour:'Praline', category:'Heels', gender:'Women', listing_type:'both', rrp:695, rent_price:7.43, buy_price:194, condition:'Very Good', emoji:'👠', auth_score:90, auth_grade:'A', assessed_wear_grade:'Good', status:'listed', days_ago:95, rental_count:5, clean_count:6, listing_count:3, description:'Gianvito Rossi Portofino in praline. The column heel.' });
  await insertShoe(amaraId, { brand:'Aquazzura', model:'Twist 95', size:'4.5', colour:'Gold', category:'Heels', gender:'Women', listing_type:'rent', rrp:680, rent_price:2.91, buy_price:null, condition:'Good', emoji:'👠', auth_score:85, auth_grade:'A', assessed_wear_grade:'Good', status:'listed', days_ago:130, rental_count:7, clean_count:8, listing_count:4, description:'Aquazzura Twist in gold. Statement evening heel.' });
  await insertShoe(amaraId, { brand:'Veja', model:'V-10', size:'6', colour:'White/B-Mesh', category:'Sneaker', gender:'Women', listing_type:'both', rrp:150, rent_price:3.21, buy_price:105, condition:'Brand New', emoji:'👟', auth_score:98, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:22, rental_count:0, clean_count:1, listing_count:1, description:'Veja V-10 in white. Sustainably made, beautifully designed.' });
  await insertShoe(amaraId, { brand:'Sandro', model:'Pointed Kitten Heel', size:'5', colour:'Caramel', category:'Heels', gender:'Women', listing_type:'both', rrp:280, rent_price:6.00, buy_price:196, condition:'Brand New', emoji:'👠', auth_score:98, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:9, rental_count:0, clean_count:1, listing_count:1, description:'Sandro pointed kitten heel in caramel. French girl staple.' });
  await insertShoe(amaraId, { brand:'Carel', model:'Dolly Mary Jane', size:'5.5', colour:'Black Patent', category:'Flats', gender:'Women', listing_type:'both', rrp:320, rent_price:6.86, buy_price:224, condition:'Brand New', emoji:'🥿', auth_score:99, auth_grade:'A+', assessed_wear_grade:'Mint', status:'listed', days_ago:4, rental_count:0, clean_count:1, listing_count:1, description:'Carel Dolly Mary Jane in black patent. Parisian chic.' });

  // ── PRE-LOVED SUBMISSIONS ──────────────────────────────────────────────────
  await insertShoe(mikeId, { brand:'Nike', model:'Air Force 1 Low', size:'8.5', colour:'White', category:'Sneaker', listing_type:'both', rrp:100, rent_price:1.46, buy_price:28, condition:'Fair', emoji:'👟', auth_score:77, auth_grade:'B+', assessed_wear_grade:'Fair', is_pre_loved:true, status:'listed', days_ago:160, rental_count:10, clean_count:11, listing_count:5, description:'Pre-loved AF1. Team assessed Fair at intake — classic toe-box creasing.' });
  await insertShoe(sophieId, { brand:'Chanel', model:'Cap-Toe Slingback', size:'5.5', colour:'Beige/Black', category:'Heels', gender:'Women', listing_type:'both', rrp:1200, rent_price:7.71, buy_price:192, condition:'Very Good', emoji:'👠', auth_score:90, auth_grade:'A', assessed_wear_grade:'Good', is_pre_loved:true, status:'listed', days_ago:75, rental_count:5, clean_count:6, listing_count:3, description:'Pre-loved Chanel Cap-Toe Slingback. Authenticated and assessed Good by our team.' });
  await insertShoe(jamesId, { brand:'Adidas', model:'Forum Low', size:'10', colour:'White/Royal', category:'Sneaker', gender:'Men', listing_type:'both', rrp:90, rent_price:0.77, buy_price:14, condition:'Fair', emoji:'👟', auth_score:73, auth_grade:'B', assessed_wear_grade:'Vintage', is_pre_loved:true, status:'listed', days_ago:250, rental_count:17, clean_count:18, listing_count:8, description:'Pre-loved Forum Low. Vintage grade — extensively worn, loads of character.' });
  await insertShoe(amaraId, { brand:'Birkenstock', model:'Arizona', size:'5.5', colour:'Tan Oiled Leather', category:'Sandals', listing_type:'both', rrp:130, rent_price:0.99, buy_price:18, condition:'Fair', emoji:'👡', auth_score:75, auth_grade:'B+', assessed_wear_grade:'Vintage', is_pre_loved:true, status:'listed', days_ago:290, rental_count:20, clean_count:21, listing_count:9, description:'Pre-loved Birkenstock Arizona. Vintage grade — perfectly moulded footbed.' });

  // ── CHARITY DONATIONS ──────────────────────────────────────────────────────
  const { rows: adminRows } = await db.query(`SELECT id FROM users WHERE email = 'admin@kosmos.co.uk' LIMIT 1`);
  const adminId = adminRows[0]?.id;

  const { rows: don1 } = await db.query(`
    INSERT INTO donations (reference, donor_name, donor_email, shoe_description, pair_count, collection_line1, collection_city, collection_postcode, status)
    VALUES ('DON-CHN-7821','Sarah Chen','sarah.chen@gmail.com','2x Nike trainers, 1x ladies heels',3,'42 Park Lane','London','W1K 2JT','listed')
    ON CONFLICT (reference) DO NOTHING RETURNING id
  `);

  const { rows: don2 } = await db.query(`
    INSERT INTO donations (reference, donor_name, donor_email, shoe_description, pair_count, collection_line1, collection_city, collection_postcode, status)
    VALUES ('DON-HRT-3344','Tom Hartley','tomh@outlook.com','Assorted boots and trainers mens 9-10',4,'7 Brunswick Gardens','London','W8 4AN','listed')
    ON CONFLICT (reference) DO NOTHING RETURNING id
  `);

  if (adminId && don1[0]) {
    const d1 = don1[0].id;
    await insertShoe(adminId, { brand:'Nike', model:'Air Max 97', size:'6', colour:'Silver Bullet', category:'Sneaker', gender:'Women', listing_type:'both', rrp:150, rent_price:1.93, buy_price:37, condition:'Good', emoji:'👟', auth_score:85, auth_grade:'A', assessed_wear_grade:'Good', is_pre_loved:true, status:'listed', days_ago:80, rental_count:5, clean_count:6, listing_count:3, donation_id:d1, description:'Donated via Kosmos — 100% profits to Soles4Souls UK. Air Max 97 Silver Bullet.' });
    await insertShoe(adminId, { brand:'Zara', model:'Kitten Heel Mule', size:'5', colour:'Beige', category:'Heels', gender:'Women', listing_type:'both', rrp:60, rent_price:0.52, buy_price:10, condition:'Fair', emoji:'👠', auth_score:72, auth_grade:'B', assessed_wear_grade:'Vintage', is_pre_loved:true, status:'listed', days_ago:80, rental_count:18, clean_count:19, listing_count:8, donation_id:d1, description:'Donated via Kosmos — 100% profits to Soles4Souls UK. Zara kitten heel, vintage grade.' });
    await insertShoe(adminId, { brand:'Converse', model:'Chuck 70 Hi', size:'7', colour:'Black', category:'Sneaker', listing_type:'both', rrp:90, rent_price:0.96, buy_price:22, condition:'Fair', emoji:'👟', auth_score:76, auth_grade:'B+', assessed_wear_grade:'Fair', is_pre_loved:true, status:'listed', days_ago:80, rental_count:10, clean_count:11, listing_count:5, donation_id:d1, description:'Donated via Kosmos — 100% profits to Soles4Souls UK. Chuck 70s, fair grade.' });
  }

  if (adminId && don2[0]) {
    const d2 = don2[0].id;
    await insertShoe(adminId, { brand:'Timberland', model:'6-Inch Premium Boot', size:'9', colour:'Wheat', category:'Boots', gender:'Men', listing_type:'both', rrp:220, rent_price:0.71, buy_price:10, condition:'Fair', emoji:'🥾', auth_score:70, auth_grade:'B', assessed_wear_grade:'Vintage', is_pre_loved:true, status:'listed', days_ago:55, rental_count:19, clean_count:20, listing_count:8, donation_id:d2, description:'Donated via Kosmos — 100% profits to Soles4Souls UK. Timberland 6-inch, vintage grade.' });
    await insertShoe(adminId, { brand:'Nike', model:'Air Force 1 Mid', size:'10', colour:'Triple White', category:'Sneaker', gender:'Men', listing_type:'both', rrp:115, rent_price:1.23, buy_price:32, condition:'Fair', emoji:'👟', auth_score:74, auth_grade:'B+', assessed_wear_grade:'Fair', is_pre_loved:true, status:'listed', days_ago:55, rental_count:11, clean_count:12, listing_count:6, donation_id:d2, description:'Donated via Kosmos — 100% profits to Soles4Souls UK. AF1 Mid, fair grade.' });
    await insertShoe(adminId, { brand:'Dr. Martens', model:'1460 Pascal', size:'9', colour:'Virginia Leather', category:'Boots', gender:'Men', listing_type:'both', rrp:190, rent_price:0.61, buy_price:11, condition:'Fair', emoji:'🥾', auth_score:72, auth_grade:'B', assessed_wear_grade:'Vintage', is_pre_loved:true, status:'listed', days_ago:55, rental_count:20, clean_count:21, listing_count:9, donation_id:d2, description:'Donated via Kosmos — 100% profits to Soles4Souls UK. DMs vintage grade, beautifully worn in.' });
  }

  console.log('✅ Seed complete.');
  console.log('   Admin:    admin@kosmos.co.uk / change_me_immediately');
  console.log('   Staff:    alex@kosmos.co.uk  / kosmos_staff');
  console.log('   Customer: jane@example.com   / password123');
  console.log('   Owners:   mike, sophie, james, amara @example.com / password123');
  console.log('   ~50 shoes across all wear grades, pre-loved and charity donations');
  process.exit(0);
};

seed().catch(err => { console.error('Seed failed:', err); process.exit(1); });
