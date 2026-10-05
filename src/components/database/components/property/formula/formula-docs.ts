// Display documentation only. Native completion decides which functions are available.
export interface FormulaFunctionExample {
  expression: string;
  result: string;
}
export interface FormulaFunctionSpec {
  name: string;
  signature: string;
  description: string;
  examples: FormulaFunctionExample[];
}
export const FORMULA_FUNCTION_DOCS: readonly FormulaFunctionSpec[] = [
  {
    name: 'if',
    signature: 'if(condition, valueIfTrue, valueIfFalse)',
    description: 'Returns the first value if the condition is true; otherwise, returns the second value.',
    examples: [
      {
        expression: 'if(true, 1, 2)',
        result: '1',
      },
      {
        expression: 'if(prop("Checked") == true, "Complete", "Incomplete")',
        result: '"Complete"',
      },
    ],
  },
  {
    name: 'ifs',
    signature: 'ifs(condition1, value1, condition2, value2, ..., default)',
    description:
      'Returns the value for the first true condition. An alternative to nested if() calls. Without a default, no match is empty.',
    examples: [
      {
        expression: 'ifs(true, 1, true, 2, 3)',
        result: '1',
      },
      {
        expression: 'ifs(false, 1, false, 2, 3)',
        result: '3',
      },
      {
        expression: 'ifs(false, "Overdue")',
        result: 'empty',
      },
    ],
  },
  {
    name: 'empty',
    signature: 'empty(value)',
    description:
      'Returns true if the value is empty. 0, "", false, and [] are considered empty. Called with no argument, it is the empty value itself.',
    examples: [
      {
        expression: 'empty(0)',
        result: 'true',
      },
      {
        expression: 'empty([])',
        result: 'true',
      },
      {
        expression: 'if(empty(prop("Date")), empty(), prop("Date"))',
        result: 'the date, or nothing',
      },
    ],
  },
  {
    name: 'equal',
    signature: 'equal(value1, value2)',
    description: 'Returns true if both values are equal. Same as the == operator.',
    examples: [
      {
        expression: 'equal(1, 1)',
        result: 'true',
      },
      {
        expression: '"a" == "b"',
        result: 'false',
      },
    ],
  },
  {
    name: 'unequal',
    signature: 'unequal(value1, value2)',
    description: 'Returns true if the values are not equal. Same as the != operator.',
    examples: [
      {
        expression: 'unequal(1, 2)',
        result: 'true',
      },
    ],
  },
  {
    name: 'and',
    signature: 'and(condition1, condition2, ...)',
    description: 'Returns true if every condition is true. Same as the and / && operator.',
    examples: [
      {
        expression: 'and(true, false)',
        result: 'false',
      },
      {
        expression: 'prop("Done") and prop("Reviewed")',
        result: 'true when both are checked',
      },
    ],
  },
  {
    name: 'or',
    signature: 'or(condition1, condition2, ...)',
    description: 'Returns true if any condition is true. Same as the or / || operator.',
    examples: [
      {
        expression: 'or(true, false)',
        result: 'true',
      },
    ],
  },
  {
    name: 'not',
    signature: 'not(condition)',
    description: 'Returns the opposite of the condition. Same as the not / ! operator.',
    examples: [
      {
        expression: 'not(true)',
        result: 'false',
      },
    ],
  },
  {
    name: 'let',
    signature: 'let(name, value, expression)',
    description:
      'Creates a variable with the given name and value, then evaluates the expression with that variable in scope.',
    examples: [
      {
        expression: 'let(x, 2, x * x)',
        result: '4',
      },
      {
        expression: 'let(tax, prop("Subtotal") * 0.1, prop("Subtotal") + tax)',
        result: 'subtotal plus 10%',
      },
    ],
  },
  {
    name: 'lets',
    signature: 'lets(name1, value1, name2, value2, ..., expression)',
    description: 'Creates several variables at once, then evaluates the expression with them in scope.',
    examples: [
      {
        expression: 'lets(a, 1, b, 2, a + b)',
        result: '3',
      },
    ],
  },
  {
    name: 'length',
    signature: 'length(text or list)',
    description: 'Returns the number of Unicode characters in text, or the number of items in a list.',
    examples: [
      {
        expression: 'length("hello")',
        result: '5',
      },
      {
        expression: '[1, 2, 3].length()',
        result: '3',
      },
    ],
  },
  {
    name: 'substring',
    signature: 'substring(text, startIndex, endIndex?)',
    description:
      'Returns the part of the text from the start index (inclusive) to the end index (optional and exclusive).',
    examples: [
      {
        expression: 'substring("Notion", 0, 3)',
        result: '"Not"',
      },
      {
        expression: 'substring("Notion", 3)',
        result: '"ion"',
      },
    ],
  },
  {
    name: 'contains',
    signature: 'contains(text, search)',
    description: 'Returns true if the search text is present in the value.',
    examples: [
      {
        expression: 'contains("Notion", "ot")',
        result: 'true',
      },
    ],
  },
  {
    name: 'test',
    signature: 'test(text, regex)',
    description: 'Returns true if the text matches the regular expression.',
    examples: [
      {
        expression: 'test("Notion", "Not")',
        result: 'true',
      },
      {
        expression: 'test("Notion", "\\\\d")',
        result: 'false',
      },
    ],
  },
  {
    name: 'match',
    signature: 'match(text, regex)',
    description: 'Returns every match of the regular expression as a list of text.',
    examples: [
      {
        expression: 'match("a1b22", "\\\\d+")',
        result: '["1", "22"]',
      },
    ],
  },
  {
    name: 'replace',
    signature: 'replace(text, regex, replacement)',
    description: 'Replaces the first match of the regular expression with the replacement text.',
    examples: [
      {
        expression: 'replace("a-b-c", "-", "+")',
        result: '"a+b-c"',
      },
    ],
  },
  {
    name: 'replaceAll',
    signature: 'replaceAll(text, regex, replacement)',
    description: 'Replaces every match of the regular expression with the replacement text.',
    examples: [
      {
        expression: 'replaceAll("a-b-c", "-", "")',
        result: '"abc"',
      },
    ],
  },
  {
    name: 'lower',
    signature: 'lower(text)',
    description: 'Converts the text to lowercase.',
    examples: [
      {
        expression: 'lower("HELLO")',
        result: '"hello"',
      },
    ],
  },
  {
    name: 'upper',
    signature: 'upper(text)',
    description: 'Converts the text to uppercase.',
    examples: [
      {
        expression: 'upper("hello")',
        result: '"HELLO"',
      },
    ],
  },
  {
    name: 'repeat',
    signature: 'repeat(text, count)',
    description: 'Repeats the text the given number of times.',
    examples: [
      {
        expression: 'repeat("*", 3)',
        result: '"***"',
      },
    ],
  },
  {
    name: 'trim',
    signature: 'trim(text)',
    description: 'Removes whitespace from the beginning and end of the text.',
    examples: [
      {
        expression: 'trim("  hi  ")',
        result: '"hi"',
      },
    ],
  },
  {
    name: 'style',
    signature: 'style(text, style1, style2, ...)',
    description:
      'Accepts Notion text styles ("b", "i", "u", "s", "c", colors and "_background" colors) so pasted formulas work. Formula results show as plain text, so the styles are not applied.',
    examples: [
      {
        expression: 'style("Done", "b", "green")',
        result: '"Done"',
      },
    ],
  },
  {
    name: 'unstyle',
    signature: 'unstyle(text, style1, style2, ...)',
    description:
      'Accepts Notion text styles to remove so pasted formulas work. Formula results show as plain text, so the text is returned unchanged.',
    examples: [
      {
        expression: 'unstyle("Done", "b")',
        result: '"Done"',
      },
    ],
  },
  {
    name: 'split',
    signature: 'split(text, separator)',
    description: 'Splits the text into a list at every occurrence of the separator.',
    examples: [
      {
        expression: 'split("a,b,c", ",")',
        result: '["a", "b", "c"]',
      },
    ],
  },
  {
    name: 'join',
    signature: 'join(list, separator)',
    description: 'Joins the items of a list into one text value, placing the separator between items.',
    examples: [
      {
        expression: 'join(["a", "b"], ", ")',
        result: '"a, b"',
      },
    ],
  },
  {
    name: 'format',
    signature: 'format(value)',
    description: 'Converts any value to text.',
    examples: [
      {
        expression: 'format(42)',
        result: '"42"',
      },
      {
        expression: 'format(true)',
        result: '"true"',
      },
    ],
  },
  {
    name: 'toNumber',
    signature: 'toNumber(value)',
    description: 'Parses a number from text. Dates become their timestamp in milliseconds; true becomes 1.',
    examples: [
      {
        expression: 'toNumber("42")',
        result: '42',
      },
      {
        expression: 'toNumber(true)',
        result: '1',
      },
    ],
  },
  {
    name: 'add',
    signature: 'add(number1, number2)',
    description: 'Adds two numbers. Same as the + operator.',
    examples: [
      {
        expression: 'add(1, 2)',
        result: '3',
      },
    ],
  },
  {
    name: 'subtract',
    signature: 'subtract(number1, number2)',
    description: 'Subtracts the second number from the first. Same as the - operator.',
    examples: [
      {
        expression: 'subtract(5, 2)',
        result: '3',
      },
    ],
  },
  {
    name: 'multiply',
    signature: 'multiply(number1, number2)',
    description: 'Multiplies two numbers. Same as the * operator.',
    examples: [
      {
        expression: 'multiply(3, 4)',
        result: '12',
      },
    ],
  },
  {
    name: 'divide',
    signature: 'divide(number1, number2)',
    description: 'Divides the first number by the second. Same as the / operator.',
    examples: [
      {
        expression: 'divide(8, 2)',
        result: '4',
      },
    ],
  },
  {
    name: 'mod',
    signature: 'mod(number1, number2)',
    description: 'Returns the remainder of dividing the first number by the second. Same as the % operator.',
    examples: [
      {
        expression: 'mod(7, 3)',
        result: '1',
      },
    ],
  },
  {
    name: 'pow',
    signature: 'pow(number1, number2)',
    description: 'Raises the first number to the power of the second. Same as the ^ operator.',
    examples: [
      {
        expression: 'pow(2, 10)',
        result: '1024',
      },
    ],
  },
  {
    name: 'abs',
    signature: 'abs(number)',
    description: 'Returns the absolute value of the number.',
    examples: [
      {
        expression: 'abs(-3)',
        result: '3',
      },
    ],
  },
  {
    name: 'round',
    signature: 'round(number, decimals?)',
    description: 'Rounds to the nearest integer, or to the given number of decimal places.',
    examples: [
      {
        expression: 'round(3.6)',
        result: '4',
      },
      {
        expression: 'round(3.14159, 2)',
        result: '3.14',
      },
    ],
  },
  {
    name: 'ceil',
    signature: 'ceil(number)',
    description: 'Rounds up to the smallest integer that is greater than or equal to the number.',
    examples: [
      {
        expression: 'ceil(3.2)',
        result: '4',
      },
    ],
  },
  {
    name: 'floor',
    signature: 'floor(number)',
    description: 'Rounds down to the largest integer that is less than or equal to the number.',
    examples: [
      {
        expression: 'floor(3.8)',
        result: '3',
      },
    ],
  },
  {
    name: 'sqrt',
    signature: 'sqrt(number)',
    description: 'Returns the positive square root of the number.',
    examples: [
      {
        expression: 'sqrt(16)',
        result: '4',
      },
    ],
  },
  {
    name: 'cbrt',
    signature: 'cbrt(number)',
    description: 'Returns the cube root of the number.',
    examples: [
      {
        expression: 'cbrt(27)',
        result: '3',
      },
    ],
  },
  {
    name: 'exp',
    signature: 'exp(number)',
    description: 'Returns e raised to the power of the number.',
    examples: [
      {
        expression: 'exp(0)',
        result: '1',
      },
    ],
  },
  {
    name: 'ln',
    signature: 'ln(number)',
    description: 'Returns the natural logarithm of the number.',
    examples: [
      {
        expression: 'ln(e())',
        result: '1',
      },
    ],
  },
  {
    name: 'log10',
    signature: 'log10(number)',
    description: 'Returns the base 10 logarithm of the number.',
    examples: [
      {
        expression: 'log10(1000)',
        result: '3',
      },
    ],
  },
  {
    name: 'log2',
    signature: 'log2(number)',
    description: 'Returns the base 2 logarithm of the number.',
    examples: [
      {
        expression: 'log2(8)',
        result: '3',
      },
    ],
  },
  {
    name: 'sign',
    signature: 'sign(number)',
    description: 'Returns 1 for positive numbers, -1 for negative numbers, and 0 for zero.',
    examples: [
      {
        expression: 'sign(-5)',
        result: '-1',
      },
    ],
  },
  {
    name: 'min',
    signature: 'min(number1, number2, ...) or min(list)',
    description: 'Returns the smallest of the numbers. Accepts several numbers or a list of numbers.',
    examples: [
      {
        expression: 'min(3, 1, 2)',
        result: '1',
      },
      {
        expression: 'min([3, 1, 2])',
        result: '1',
      },
    ],
  },
  {
    name: 'max',
    signature: 'max(number1, number2, ...) or max(list)',
    description: 'Returns the largest of the numbers. Accepts several numbers or a list of numbers.',
    examples: [
      {
        expression: 'max(3, 1, 2)',
        result: '3',
      },
    ],
  },
  {
    name: 'sum',
    signature: 'sum(number1, number2, ...) or sum(list)',
    description: 'Returns the total of the numbers. Accepts several numbers or a list of numbers.',
    examples: [
      {
        expression: 'sum([1, 2, 3])',
        result: '6',
      },
    ],
  },
  {
    name: 'mean',
    signature: 'mean(number1, number2, ...) or mean(list)',
    description: 'Returns the arithmetic average of the numbers.',
    examples: [
      {
        expression: 'mean(1, 2, 3)',
        result: '2',
      },
    ],
  },
  {
    name: 'median',
    signature: 'median(number1, number2, ...) or median(list)',
    description: 'Returns the middle value of the numbers.',
    examples: [
      {
        expression: 'median(1, 2, 10)',
        result: '2',
      },
    ],
  },
  {
    name: 'pi',
    signature: 'pi()',
    description: 'Returns the ratio of a circle’s circumference to its diameter.',
    examples: [
      {
        expression: 'pi()',
        result: '3.14159...',
      },
    ],
  },
  {
    name: 'e',
    signature: 'e()',
    description: 'Returns the base of the natural logarithm.',
    examples: [
      {
        expression: 'e()',
        result: '2.71828...',
      },
    ],
  },
  {
    name: 'formatNumber',
    signature: 'formatNumber(number, format, decimals?)',
    description:
      'Formats a number as text. Formats: "commas", "percent", "humanize", or a currency code such as "usd", "eur", "gbp".',
    examples: [
      {
        expression: 'formatNumber(1234.5, "commas")',
        result: '"1,234.5"',
      },
      {
        expression: 'formatNumber(0.25, "percent")',
        result: '"25%"',
      },
      {
        expression: 'formatNumber(1500, "usd", 2)',
        result: '"$1,500.00"',
      },
    ],
  },
  {
    name: 'now',
    signature: 'now()',
    description: 'Returns the current date and time.',
    examples: [
      {
        expression: 'now()',
        result: 'the current date and time',
      },
    ],
  },
  {
    name: 'today',
    signature: 'today()',
    description: 'Returns the current date, without a time.',
    examples: [
      {
        expression: 'today()',
        result: "today's date",
      },
    ],
  },
  {
    name: 'timestamp',
    signature: 'timestamp(date)',
    description: 'Returns the number of milliseconds since January 1, 1970 for the date.',
    examples: [
      {
        expression: 'timestamp(parseDate("1970-01-02"))',
        result: '86400000 (in UTC)',
      },
    ],
  },
  {
    name: 'fromTimestamp',
    signature: 'fromTimestamp(number)',
    description: 'Returns the date for a number of milliseconds since January 1, 1970.',
    examples: [
      {
        expression: 'fromTimestamp(0)',
        result: 'January 1, 1970',
      },
    ],
  },
  {
    name: 'minute',
    signature: 'minute(date)',
    description: 'Returns the minute of the date, from 0 to 59.',
    examples: [
      {
        expression: 'minute(now())',
        result: '0 to 59',
      },
    ],
  },
  {
    name: 'hour',
    signature: 'hour(date)',
    description: 'Returns the hour of the date, from 0 to 23.',
    examples: [
      {
        expression: 'hour(now())',
        result: '0 to 23',
      },
    ],
  },
  {
    name: 'day',
    signature: 'day(date)',
    description: 'Returns the day of the week, from 1 (Monday) to 7 (Sunday).',
    examples: [
      {
        expression: 'day(parseDate("2024-01-01"))',
        result: '1',
      },
    ],
  },
  {
    name: 'date',
    signature: 'date(date)',
    description: 'Returns the day of the month, from 1 to 31.',
    examples: [
      {
        expression: 'date(parseDate("2024-01-15"))',
        result: '15',
      },
    ],
  },
  {
    name: 'week',
    signature: 'week(date)',
    description: 'Returns the ISO week of the year, from 1 to 53.',
    examples: [
      {
        expression: 'week(parseDate("2024-01-01"))',
        result: '1',
      },
    ],
  },
  {
    name: 'month',
    signature: 'month(date)',
    description: 'Returns the month of the date, from 1 to 12.',
    examples: [
      {
        expression: 'month(parseDate("2024-03-01"))',
        result: '3',
      },
    ],
  },
  {
    name: 'year',
    signature: 'year(date)',
    description: 'Returns the year of the date.',
    examples: [
      {
        expression: 'year(parseDate("2024-03-01"))',
        result: '2024',
      },
    ],
  },
  {
    name: 'dateAdd',
    signature: 'dateAdd(date, amount, unit)',
    description: 'Adds time to a date. Units: "years", "quarters", "months", "weeks", "days", "hours", "minutes".',
    examples: [
      {
        expression: 'dateAdd(prop("Start"), 2, "weeks")',
        result: 'two weeks after Start',
      },
    ],
  },
  {
    name: 'dateSubtract',
    signature: 'dateSubtract(date, amount, unit)',
    description:
      'Subtracts time from a date. Units: "years", "quarters", "months", "weeks", "days", "hours", "minutes".',
    examples: [
      {
        expression: 'dateSubtract(now(), 1, "months")',
        result: 'one month ago',
      },
    ],
  },
  {
    name: 'dateBetween',
    signature: 'dateBetween(date1, date2, unit)',
    description: 'Returns the time between two dates in the given unit (date1 minus date2), rounded toward zero.',
    examples: [
      {
        expression: 'dateBetween(prop("Due"), now(), "days")',
        result: 'days until Due',
      },
    ],
  },
  {
    name: 'dateRange',
    signature: 'dateRange(start, end)',
    description: 'Creates a date range from a start date and an end date.',
    examples: [
      {
        expression: 'dateRange(prop("Start"), prop("End"))',
        result: 'Start → End',
      },
    ],
  },
  {
    name: 'dateStart',
    signature: 'dateStart(dateRange)',
    description: 'Returns the start of a date range.',
    examples: [
      {
        expression: 'dateStart(prop("Sprint"))',
        result: 'the first day of Sprint',
      },
    ],
  },
  {
    name: 'dateEnd',
    signature: 'dateEnd(dateRange)',
    description: 'Returns the end of a date range, or the date itself when it has no end.',
    examples: [
      {
        expression: 'dateEnd(prop("Sprint"))',
        result: 'the last day of Sprint',
      },
    ],
  },
  {
    name: 'parseDate',
    signature: 'parseDate(text)',
    description: 'Parses a date from ISO 8601 text such as "2024-03-01" or "2024-03-01T09:30:00".',
    examples: [
      {
        expression: 'parseDate("2024-03-01")',
        result: 'March 1, 2024',
      },
    ],
  },
  {
    name: 'formatDate',
    signature: 'formatDate(date, format)',
    description:
      'Formats a date as text. Tokens: YYYY, Y, MM, MMM, MMMM, D, DD, Do, DDD, ddd, dddd, E, H, HH, h, hh, mm, ss, A, Q, w, wo, W, Wo, X, x. Wrap literal text in [brackets].',
    examples: [
      {
        expression: 'formatDate(parseDate("2024-03-01"), "MMM D, YYYY")',
        result: '"Mar 1, 2024"',
      },
      {
        expression: 'formatDate(now(), "[Week] W")',
        result: '"Week 10"',
      },
    ],
  },
  {
    name: 'at',
    signature: 'at(list, index)',
    description: 'Returns the item at the given position in the list. The first item is at index 0.',
    examples: [
      {
        expression: '[1, 2, 3].at(1)',
        result: '2',
      },
    ],
  },
  {
    name: 'first',
    signature: 'first(list)',
    description: 'Returns the first item in the list.',
    examples: [
      {
        expression: 'first([1, 2, 3])',
        result: '1',
      },
    ],
  },
  {
    name: 'last',
    signature: 'last(list)',
    description: 'Returns the last item in the list.',
    examples: [
      {
        expression: 'last([1, 2, 3])',
        result: '3',
      },
    ],
  },
  {
    name: 'slice',
    signature: 'slice(list, startIndex, endIndex?)',
    description: 'Returns the items from the start index (inclusive) to the end index (optional and exclusive).',
    examples: [
      {
        expression: '[1, 2, 3].slice(1)',
        result: '[2, 3]',
      },
    ],
  },
  {
    name: 'concat',
    signature: 'concat(list1, list2, ...)',
    description: 'Combines several lists into one. Use + to combine text.',
    examples: [
      {
        expression: 'concat([1], [2, 3])',
        result: '[1, 2, 3]',
      },
    ],
  },
  {
    name: 'sort',
    signature: 'sort(list)',
    description: 'Returns the list sorted in ascending order.',
    examples: [
      {
        expression: 'sort([3, 1, 2])',
        result: '[1, 2, 3]',
      },
    ],
  },
  {
    name: 'reverse',
    signature: 'reverse(list)',
    description: 'Returns the list in reverse order.',
    examples: [
      {
        expression: 'reverse([1, 2, 3])',
        result: '[3, 2, 1]',
      },
    ],
  },
  {
    name: 'unique',
    signature: 'unique(list)',
    description: 'Returns the list with duplicate items removed.',
    examples: [
      {
        expression: 'unique([1, 1, 2])',
        result: '[1, 2]',
      },
    ],
  },
  {
    name: 'includes',
    signature: 'includes(list, value)',
    description: 'Returns true if the list contains the value.',
    examples: [
      {
        expression: '["a", "b"].includes("a")',
        result: 'true',
      },
    ],
  },
  {
    name: 'flat',
    signature: 'flat(list)',
    description: 'Flattens a list of lists into a single list.',
    examples: [
      {
        expression: 'flat([[1, 2], [3]])',
        result: '[1, 2, 3]',
      },
    ],
  },
  {
    name: 'map',
    signature: 'map(list, expression)',
    description:
      'Transforms every item in the list with the expression. Use `current` for the item and `index` for its position.',
    examples: [
      {
        expression: '[1, 2, 3].map(current * 2)',
        result: '[2, 4, 6]',
      },
    ],
  },
  {
    name: 'filter',
    signature: 'filter(list, condition)',
    description: 'Keeps only the items for which the condition is true. Use `current` for the item.',
    examples: [
      {
        expression: '[1, 2, 3].filter(current > 1)',
        result: '[2, 3]',
      },
    ],
  },
  {
    name: 'find',
    signature: 'find(list, condition)',
    description: 'Returns the first item for which the condition is true.',
    examples: [
      {
        expression: '[1, 2, 3].find(current > 1)',
        result: '2',
      },
    ],
  },
  {
    name: 'findIndex',
    signature: 'findIndex(list, condition)',
    description: 'Returns the position of the first item for which the condition is true, or -1 if none matches.',
    examples: [
      {
        expression: '[1, 2, 3].findIndex(current > 1)',
        result: '1',
      },
    ],
  },
  {
    name: 'some',
    signature: 'some(list, condition)',
    description: 'Returns true if the condition is true for at least one item.',
    examples: [
      {
        expression: '[1, 2, 3].some(current > 2)',
        result: 'true',
      },
    ],
  },
  {
    name: 'every',
    signature: 'every(list, condition)',
    description: 'Returns true if the condition is true for every item.',
    examples: [
      {
        expression: '[1, 2, 3].every(current > 0)',
        result: 'true',
      },
    ],
  },
  {
    name: 'id',
    signature: 'id()',
    description: 'Returns the id of the current row.',
    examples: [
      {
        expression: 'id()',
        result: '"a1b2c3..."',
      },
    ],
  },
];
export interface FormulaBuiltinSpec extends FormulaFunctionSpec {
  insert: string;
}
export const FORMULA_BUILTIN_DOCS: readonly FormulaBuiltinSpec[] = [
  {
    name: '+',
    insert: ' + ',
    signature: 'number + number, text + text',
    description: 'Adds two numbers, or joins two text values.',
    examples: [
      {
        expression: '3 + 2',
        result: '5',
      },
      {
        expression: '"Hello" + " " + "world"',
        result: '"Hello world"',
      },
    ],
  },
  {
    name: '-',
    insert: ' - ',
    signature: 'number - number',
    description: 'Subtracts the second number from the first.',
    examples: [
      {
        expression: '5 - 2',
        result: '3',
      },
    ],
  },
  {
    name: '*',
    insert: ' * ',
    signature: 'number * number',
    description: 'Multiplies two numbers.',
    examples: [
      {
        expression: '3 * 4',
        result: '12',
      },
    ],
  },
  {
    name: '/',
    insert: ' / ',
    signature: 'number / number',
    description: 'Divides the first number by the second.',
    examples: [
      {
        expression: '8 / 2',
        result: '4',
      },
    ],
  },
  {
    name: '%',
    insert: ' % ',
    signature: 'number % number',
    description: 'Returns the remainder of a division.',
    examples: [
      {
        expression: '7 % 3',
        result: '1',
      },
    ],
  },
  {
    name: '^',
    insert: ' ^ ',
    signature: 'number ^ number',
    description: 'Raises the first number to the power of the second.',
    examples: [
      {
        expression: '2 ^ 10',
        result: '1024',
      },
    ],
  },
  {
    name: '==',
    insert: ' == ',
    signature: 'value == value',
    description: 'Returns true when both values are equal.',
    examples: [
      {
        expression: '"a" == "a"',
        result: 'true',
      },
    ],
  },
  {
    name: '!=',
    insert: ' != ',
    signature: 'value != value',
    description: 'Returns true when the values are different.',
    examples: [
      {
        expression: '1 != 2',
        result: 'true',
      },
    ],
  },
  {
    name: '>',
    insert: ' > ',
    signature: 'value > value',
    description: 'Returns true when the first value is greater. Works with numbers, dates and text.',
    examples: [
      {
        expression: '3 > 2',
        result: 'true',
      },
    ],
  },
  {
    name: '>=',
    insert: ' >= ',
    signature: 'value >= value',
    description: 'Returns true when the first value is greater than or equal to the second.',
    examples: [
      {
        expression: '2 >= 2',
        result: 'true',
      },
    ],
  },
  {
    name: '<',
    insert: ' < ',
    signature: 'value < value',
    description: 'Returns true when the first value is smaller.',
    examples: [
      {
        expression: 'prop("Due") < now()',
        result: 'true when Due is in the past',
      },
    ],
  },
  {
    name: '<=',
    insert: ' <= ',
    signature: 'value <= value',
    description: 'Returns true when the first value is smaller than or equal to the second.',
    examples: [
      {
        expression: '1 <= 2',
        result: 'true',
      },
    ],
  },
  {
    name: 'and',
    insert: ' and ',
    signature: 'boolean and boolean',
    description: 'Returns true when both sides are true. Also written as &&.',
    examples: [
      {
        expression: 'true and false',
        result: 'false',
      },
    ],
  },
  {
    name: 'or',
    insert: ' or ',
    signature: 'boolean or boolean',
    description: 'Returns true when either side is true. Also written as ||.',
    examples: [
      {
        expression: 'true or false',
        result: 'true',
      },
    ],
  },
  {
    name: 'not',
    insert: 'not ',
    signature: 'not boolean',
    description: 'Returns the opposite boolean. Also written as !.',
    examples: [
      {
        expression: 'not true',
        result: 'false',
      },
    ],
  },
  {
    name: '? :',
    insert: ' ? ',
    signature: 'condition ? valueIfTrue : valueIfFalse',
    description: 'Shorthand for if(condition, valueIfTrue, valueIfFalse).',
    examples: [
      {
        expression: 'prop("Done") ? "Complete" : "Open"',
        result: '"Complete" when Done is checked',
      },
    ],
  },
  {
    name: 'true',
    insert: 'true',
    signature: 'true',
    description: 'The boolean value true.',
    examples: [
      {
        expression: 'true',
        result: 'true',
      },
    ],
  },
  {
    name: 'false',
    insert: 'false',
    signature: 'false',
    description: 'The boolean value false.',
    examples: [
      {
        expression: 'false',
        result: 'false',
      },
    ],
  },
  {
    name: 'current',
    insert: 'current',
    signature: 'current',
    description: 'The item being processed inside map(), filter(), find(), findIndex(), some() and every().',
    examples: [
      {
        expression: '[1, 2, 3].map(current * 2)',
        result: '[2, 4, 6]',
      },
    ],
  },
  {
    name: 'index',
    insert: 'index',
    signature: 'index',
    description: 'The position of the item being processed inside map() and the other list functions.',
    examples: [
      {
        expression: '["a", "b"].map(index)',
        result: '[0, 1]',
      },
    ],
  },
];
