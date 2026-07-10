// Initial example code
export const INITIAL_CODE = `// Welcome to GoJS! ⚡
console.log('Hello from GoJS!');
console.info('GoJS is ready');

// Expressions are evaluated automatically
2 + 2;
10 * 5;
Math.sqrt(16);
'Hello' + ' ' + 'World';

// Try different data types
const numbers = [1, 2, 3, 4, 5];
console.log('Numbers:', numbers);

console.time('processing');

const result = numbers
  .map(n => n * 2)
  .filter(n => n > 5);

console.timeEnd('processing');
console.log('Result:', result);

// Warnings and errors
console.warn('This is an example warning');

try {
  throw new Error('This is an example error');
} catch (error) {
  console.error('Caught error:', error.message);
}

fetch('https://jsonplaceholder.typicode.com/todos/1')
  .then(response => response.json())
  .then(json => console.log(json))

// Works with objects
const user = {
  name: 'XJS User',
  age: 25,
  skills: ['JavaScript', 'TypeScript', 'React']
};

console.log('User:', user);

// Use console.table to visualize data
const employees = [
  { name: 'Alice', role: 'Developer', age: 28 },
  { name: 'Bob', role: 'Designer', age: 32 },
  { name: 'Charlie', role: 'Manager', age: 35 }
];

console.table(employees);
console.table(employees, ['name', 'role']);

// Use console.count to count executions
console.count('clicks');
console.count('clicks');
console.count('clicks');
console.count(); // uses 'default' as the label
`

export const SHOWCASE_INITIAL_CODE = `// GoJS runs your code as you type.
const prices = [12, 19, 8];`

export const SHOWCASE_TYPING_BLOCKS = [
  `

prices.map(price => price * 1.21);`,
  `
Math.max(...prices);`,
  `

const cart = {
  items: prices.length,
  total: prices.reduce((sum, price) => sum + price, 0)
};`,
  `

console.log('Cart:', cart);`,
] as const

export const SHOWCASE_CODE = SHOWCASE_INITIAL_CODE + SHOWCASE_TYPING_BLOCKS.join('')

export const AGENT_DEMO_INITIAL_CODE = `type CartItem = {
  name: string
  price: number
}

const applyDiscount = (
  items: CartItem[],
  percent: number
) => {
  items.forEach(item => {
    item.price = item.price * (1 - percent)
  })

  return items
}

const cart = [
  { name: 'Keyboard', price: 89.99 },
  { name: 'Mouse', price: 49.5 }
]

applyDiscount(cart, 0.2)`

export const AGENT_DEMO_FINAL_CODE = `type CartItem = {
  name: string
  price: number
}

const applyDiscount = (
  items: CartItem[],
  percent: number
) =>
  items.map(item => ({
    ...item,
    price: Number(
      (item.price * (1 - percent)).toFixed(2)
    )
  }))

const cart = [
  { name: 'Keyboard', price: 89.99 },
  { name: 'Mouse', price: 49.5 }
]

applyDiscount(cart, 0.2)`
