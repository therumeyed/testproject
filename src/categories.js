const CATEGORIES = [
  { value: 'parking', label: 'Parking' },
  { value: 'pickup_dropoff', label: 'Pick-up & drop-off' },
  { value: 'taxi_rideshare', label: 'Taxi & rideshare' },
  { value: 'public_transport', label: 'Public transport' },
  { value: 'terminal_experience', label: 'Terminal experience' },
  { value: 'general_airport', label: 'General airport' },
  { value: 'unclassified', label: 'Unclassified' }
];

const CATEGORY_VALUES = CATEGORIES.map((c) => c.value);
const CATEGORY_CONFIDENCE_THRESHOLD = 0.7;

module.exports = { CATEGORIES, CATEGORY_VALUES, CATEGORY_CONFIDENCE_THRESHOLD };
