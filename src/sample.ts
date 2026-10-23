export const SAMPLE = `// Edit the DBML on the left, the diagram updates as you type.
// Drag tables to move them, scroll to zoom, drag the canvas to pan.

Project ecommerce {
  database_type: 'PostgreSQL'
  Note: 'Sample e-commerce schema'
}

Enum order_status {
  pending
  paid
  shipped
  delivered
  cancelled
}

Table users [headercolor: #3498DB] {
  id bigint [pk, increment]
  email varchar(255) [unique, not null]
  full_name varchar(120) [not null]
  country_code char(2) [ref: > countries.code]
  created_at timestamp [default: \`now()\`]
  Note: 'Registered customers'
}

Table countries [headercolor: #7f8c8d] {
  code char(2) [pk]
  name varchar(80) [not null]
}

Table addresses {
  id bigint [pk, increment]
  user_id bigint [not null, ref: > users.id]
  line1 varchar(200) [not null]
  city varchar(80)
  postal_code varchar(12)
  country_code char(2) [ref: > countries.code]
}

Table orders [headercolor: #E67E22] {
  id bigint [pk, increment]
  user_id bigint [not null]
  shipping_address_id bigint [ref: > addresses.id]
  status order_status [not null, default: 'pending']
  total_cents integer [not null]
  placed_at timestamp [default: \`now()\`]

  indexes {
    (user_id, placed_at)
    status
  }
}

Table order_items [headercolor: #E67E22] {
  order_id bigint [pk]
  product_id bigint [pk]
  quantity integer [not null, default: 1]
  unit_price_cents integer [not null]
}

Table products [headercolor: #27AE60] {
  id bigint [pk, increment]
  category_id bigint [ref: > categories.id]
  sku varchar(40) [unique, not null]
  name varchar(160) [not null]
  description text
  price_cents integer [not null]
  active boolean [default: true]
}

Table categories [headercolor: #27AE60] {
  id bigint [pk, increment]
  parent_id bigint [ref: > categories.id, note: 'self reference']
  name varchar(80) [not null]
}

Table reviews {
  id bigint [pk, increment]
  product_id bigint [not null, ref: > products.id]
  user_id bigint [not null, ref: > users.id]
  rating smallint [not null]
  body text
}

Table audit_log {
  id bigint [pk, increment]
  message text
}

Ref: orders.user_id > users.id
Ref: order_items.order_id > orders.id
Ref: order_items.product_id > products.id

TableGroup sales {
  orders
  order_items
}

TableGroup catalog {
  products
  categories
}
`
