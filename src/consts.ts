// Código de ejemplo inicial
export const INITIAL_CODE = `// Bienvenido a XJS! ⚡
console.log('¡Hola desde XJS!');
console.info('XJS está listo para usar');

// Prueba con diferentes tipos de datos
const numbers = [1, 2, 3, 4, 5];
console.log('Números:', numbers);

console.time('procesamiento');

const result = numbers
  .map(n => n * 2)
  .filter(n => n > 5);

console.timeEnd('procesamiento');
console.log('Resultado:', result);

// Advertencias y errores
console.warn('Esto es una advertencia de ejemplo');

try {
  throw new Error('Esto es un error de ejemplo');
} catch (error) {
  console.error('Error capturado:', error.message);
}

fetch('https://jsonplaceholder.typicode.com/todos/1')
  .then(response => response.json())
  .then(json => console.log(json))

// Funciona con objetos
const user = {
  name: 'XJS User',
  age: 25,
  skills: ['JavaScript', 'TypeScript', 'React']
};

console.log('Usuario:', user);

// console.table para visualizar datos
const employees = [
  { name: 'Alice', role: 'Developer', age: 28 },
  { name: 'Bob', role: 'Designer', age: 32 },
  { name: 'Charlie', role: 'Manager', age: 35 }
];

console.table(employees);
console.table(employees, ['name', 'role']);

// console.count para contar ejecuciones
console.count('clicks');
console.count('clicks');
console.count('clicks');
console.count(); // usa 'default' como label
`
