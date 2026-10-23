// Contract: items is an array of objects with finite numeric prices.
// Return the sum of every item's price; [] returns 0.
export function totalPrice(items) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].price;
  }
  return total;
}

// Contract: user is null or an object with a string email.
// Return null for a missing user, otherwise trim and lowercase the email.
export function normalizeEmail(user) {
  return user === null ? null : user.email.trim().toLowerCase();
}
