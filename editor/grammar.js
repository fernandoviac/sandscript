export default grammar({
  name: 'sandscript',

  extras: $ => [/\s/, $.comment],

  word: $ => $.identifier,

  conflicts: $ => [
    [$.primary_expression, $.pattern],
    [$.primary_expression, $.rest_pattern],
    [$.primary_expression, $._property_name],
    [$.array, $.array_pattern],
    [$.object, $.object_pattern],
    [$.assignment_expression, $.pattern],
    [$.block, $.object],
    [$.computed_property_name, $.array],
    [$.primary_expression, $._object_property],
    [$._expression, $._object_property],
    [$.rest_pattern, $.assignment_expression],
    [$.object_pattern, $._object_property],
  ],

  supertypes: $ => [$._expression, $._statement, $._declaration],

  precedences: $ => [
    [
      'member',
      'call',
      'update',
      'unary',
      'exponentiation',
      'multiplicative',
      'additive',
      'shift',
      'relational',
      'equality',
      'bitwise_and',
      'bitwise_xor',
      'bitwise_or',
      'logical_and',
      'logical_or',
      'nullish',
      'ternary',
      'assignment',
      'declaration',
      'literal',
      'object',
    ],
  ],

  rules: {
    program: $ => repeat($._statement),

    _statement: $ => choice(
      $._declaration,
      $.expression_statement,
      $.if_statement,
      $.while_statement,
      $.do_while_statement,
      $.for_statement,
      $.for_of_statement,
      $.for_in_statement,
      $.for_await_of_statement,
      $.break_statement,
      $.continue_statement,
      $.return_statement,
      $.throw_statement,
      $.try_statement,
      $.grant_statement,
      $.block,
      $.empty_statement,
    ),

    _declaration: $ => choice(
      $.variable_declaration,
      $.function_declaration,
      $.async_function_declaration,
      $.class_declaration,
      $.export_declaration,
    ),

    // --- Declarations ---

    variable_declaration: $ => prec.right(seq(
      $._variable_declaration_inner,
      optional(';'),
    )),

    _variable_declaration_inner: $ => seq(
      field('kind', choice('let', 'const', 'var')),
      $._variable_declarator,
      repeat(seq(',', $._variable_declarator)),
    ),

    _variable_declarator: $ => prec.right(seq(
      field('name', choice($.identifier, $.array_pattern, $.object_pattern)),
      optional(seq('=', field('value', $._expression))),
    )),

    function_declaration: $ => prec.right('declaration', seq(
      'function',
      field('name', $.identifier),
      $.formal_parameters,
      field('body', $.block),
    )),

    async_function_declaration: $ => prec.right('declaration', seq(
      'async',
      'function',
      field('name', $.identifier),
      $.formal_parameters,
      field('body', $.block),
    )),

    export_declaration: $ => seq(
      'export',
      choice(
        $.variable_declaration,
        $.function_declaration,
        $.async_function_declaration,
        $.class_declaration,
      ),
    ),

    class_declaration: $ => prec.right('declaration', seq(
      'class',
      field('name', $.identifier),
      optional($.class_heritage),
      field('body', $.class_body),
    )),

    class_heritage: $ => seq('extends', $._expression),

    class_body: $ => seq(
      '{',
      repeat(choice($.class_member, ';')),
      '}',
    ),

    class_member: $ => choice(
      $.class_method,
      $.class_field,
      $.class_static_block,
    ),

    class_static_block: $ => seq('static', field('body', $.block)),

    class_method: $ => seq(
      optional('static'),
      optional(choice('async', 'get', 'set')),
      optional('*'),
      field('name', $._property_name),
      $.formal_parameters,
      field('body', $.block),
    ),

    class_field: $ => prec.right(seq(
      optional('static'),
      field('name', $._property_name),
      optional(seq('=', field('value', $._expression))),
      optional(';'),
    )),

    formal_parameters: $ => seq(
      '(',
      optional(commaSep1(choice(
        $.pattern,
        $.assignment_pattern,
      ))),
      ')',
    ),

    assignment_pattern: $ => seq(
      field('left', $.pattern),
      '=',
      field('right', $._expression),
    ),

    rest_pattern: $ => seq('...', choice($.identifier, $.array_pattern, $.object_pattern)),

    // --- Patterns ---

    pattern: $ => choice(
      $.identifier,
      alias($.array_pattern, $.array_pattern),
      alias($.object_pattern, $.object_pattern),
      $.rest_pattern,
    ),

    array_pattern: $ => seq(
      '[',
      optional(commaSep1(choice(
        $.pattern,
        $.assignment_pattern,
      ))),
      ']',
    ),

    object_pattern: $ => prec('object', seq(
      '{',
      optional(commaSep1(choice(
        $.pair_pattern,
        $.rest_pattern,
        $.object_assignment_pattern,
        alias($.identifier, $.shorthand_property_identifier_pattern),
      ))),
      '}',
    )),

    pair_pattern: $ => seq(
      field('key', $._property_name),
      ':',
      field('value', choice($.pattern, $.assignment_pattern)),
    ),

    object_assignment_pattern: $ => seq(
      field('left', choice(
        alias($.identifier, $.shorthand_property_identifier_pattern),
      )),
      '=',
      field('right', $._expression),
    ),

    // --- Statements ---

    block: $ => seq('{', repeat($._statement), '}'),

    empty_statement: $ => ';',

    expression_statement: $ => prec.right(seq($._expression, optional(';'))),

    if_statement: $ => prec.right(seq(
      'if',
      field('condition', $.parenthesized_expression),
      field('consequence', $._statement),
      optional(seq('else', field('alternative', $._statement))),
    )),

    while_statement: $ => seq(
      'while',
      field('condition', $.parenthesized_expression),
      field('body', $._statement),
    ),

    do_while_statement: $ => prec.right(seq(
      'do',
      field('body', $._statement),
      'while',
      field('condition', $.parenthesized_expression),
      optional(';'),
    )),

    for_statement: $ => seq(
      'for',
      '(',
      field('init', optional(choice($._variable_declaration_inner, $._expression))),
      ';',
      field('condition', optional($._expression)),
      ';',
      field('update', optional($._expression)),
      ')',
      field('body', $._statement),
    ),

    for_of_statement: $ => seq(
      'for',
      '(',
      field('kind', choice('let', 'const', 'var')),
      field('name', choice($.identifier, $.array_pattern, $.object_pattern)),
      'of',
      field('iterable', $._expression),
      ')',
      field('body', $._statement),
    ),

    for_await_of_statement: $ => seq(
      'for',
      'await',
      '(',
      field('kind', choice('let', 'const', 'var')),
      field('name', choice($.identifier, $.array_pattern, $.object_pattern)),
      'of',
      field('iterable', $._expression),
      ')',
      field('body', $._statement),
    ),

    for_in_statement: $ => seq(
      'for',
      '(',
      field('kind', choice('let', 'const', 'var')),
      field('name', $.identifier),
      'in',
      field('iterable', $._expression),
      ')',
      field('body', $._statement),
    ),

    break_statement: $ => prec.right(seq('break', optional(';'))),

    continue_statement: $ => prec.right(seq('continue', optional(';'))),

    return_statement: $ => prec.right(seq(
      'return',
      optional($._expression),
      optional(';'),
    )),

    throw_statement: $ => prec.right(seq(
      'throw',
      $._expression,
      optional(';'),
    )),

    try_statement: $ => seq(
      'try',
      field('body', $.block),
      optional(field('handler', $.catch_clause)),
      optional(field('finalizer', $.finally_clause)),
    ),

    catch_clause: $ => seq(
      'catch',
      optional(seq('(', field('parameter', $.identifier), ')')),
      field('body', $.block),
    ),

    finally_clause: $ => seq('finally', field('body', $.block)),

    // --- Grant / Denied (SandScript-only) ---

    grant_statement: $ => seq(
      'grant',
      field('capabilities', choice(
        $._expression,
        $.grant_capability_list,
      )),
      field('body', $.block),
      optional(field('denied', $.denied_clause)),
    ),

    grant_capability_list: $ => seq(
      '(',
      $._expression,
      ',',
      commaSep1($._expression),
      ')',
    ),

    denied_clause: $ => seq(
      'denied',
      optional(seq('(', field('parameter', $.identifier), ')')),
      field('body', $.block),
    ),

    // --- Expressions ---

    _expression: $ => choice(
      $.primary_expression,
      $.binary_expression,
      $.unary_expression,
      $.update_expression,
      $.assignment_expression,
      $.ternary_expression,
      $.member_expression,
      $.optional_chain_expression,
      $.call_expression,
      $.new_expression,
      $.new_target_expression,
      $.typeof_expression,
      $.instanceof_expression,
      $.spread_expression,
      $.await_expression,
      $.nullish_expression,
      $.arrow_function,
      $.async_arrow_function,
      $.invalid_loose_equality,
      $.invalid_keyword,
    ),

    primary_expression: $ => choice(
      $.identifier,
      $.number,
      $.bigint,
      $.string,
      $.template_string,
      $.true,
      $.false,
      $.null,
      $.undefined,
      $.this,
      $.super,
      $.array,
      $.object,
      $.function_expression,
      $.class_expression,
      $.async_function_expression,
      $.parenthesized_expression,
    ),

    parenthesized_expression: $ => seq('(', $._expression, ')'),

    binary_expression: $ => choice(
      ...[
        ['+', 'additive'],
        ['-', 'additive'],
        ['*', 'multiplicative'],
        ['/', 'multiplicative'],
        ['%', 'multiplicative'],
        ['**', 'exponentiation'],
        ['===', 'equality'],
        ['!==', 'equality'],
        ['<', 'relational'],
        ['>', 'relational'],
        ['<=', 'relational'],
        ['>=', 'relational'],
        ['&&', 'logical_and'],
        ['||', 'logical_or'],
        ['&', 'bitwise_and'],
        ['|', 'bitwise_or'],
        ['^', 'bitwise_xor'],
        ['<<', 'shift'],
        ['>>', 'shift'],
        ['>>>', 'shift'],
      ].map(([op, precedence]) =>
        (op === '**'
          ? prec.right(precedence, seq(field('left', $._expression), field('operator', op), field('right', $._expression)))
          : prec.left(precedence, seq(field('left', $._expression), field('operator', op), field('right', $._expression)))
        )
      ),
    ),

    unary_expression: $ => prec.left('unary', seq(
      field('operator', choice('!', '-', '~')),
      field('operand', $._expression),
    )),

    update_expression: $ => choice(
      prec.left('update', seq(field('operand', $._expression), field('operator', choice('++', '--')))),
      prec.right('update', seq(field('operator', choice('++', '--')), field('operand', $._expression))),
    ),

    assignment_expression: $ => prec.right('assignment', seq(
      field('left', choice(
        $.identifier,
        $.member_expression,
        $.optional_chain_expression,
        $.parenthesized_expression,
      )),
      field('operator', choice(
        '=', '+=', '-=', '*=', '/=', '%=', '**=',
        '&=', '|=', '^=', '<<=', '>>=', '>>>=',
      )),
      field('right', $._expression),
    )),

    ternary_expression: $ => prec.right('ternary', seq(
      field('condition', $._expression),
      '?',
      field('consequence', $._expression),
      ':',
      field('alternative', $._expression),
    )),

    member_expression: $ => prec('member', seq(
      field('object', $._expression),
      '.',
      field('property', choice($.identifier, $.private_name)),
    )),

    optional_chain_expression: $ => prec('member', seq(
      field('object', $._expression),
      '?.',
      field('property', choice($.identifier, $.private_name)),
    )),

    call_expression: $ => prec('call', seq(
      field('function', $._expression),
      field('arguments', $.arguments),
    )),

    arguments: $ => seq(
      '(',
      optional(commaSep1($._expression)),
      ')',
    ),

    new_expression: $ => prec.right('unary', seq(
      'new',
      field('constructor', $._expression),
      optional(field('arguments', $.arguments)),
    )),

    new_target_expression: $ => seq('new', '.', 'target'),

    typeof_expression: $ => prec.right('unary', seq('typeof', field('operand', $._expression))),

    instanceof_expression: $ => prec.left('relational', seq(
      field('left', $._expression),
      'instanceof',
      field('right', $._expression),
    )),

    spread_expression: $ => prec.right('unary', seq('...', $._expression)),

    await_expression: $ => prec.right('unary', seq('await', $._expression)),

    nullish_expression: $ => prec.left('nullish', seq(
      field('left', $._expression),
      '??',
      field('right', $._expression),
    )),

    // --- Literals ---

    true: $ => 'true',
    false: $ => 'false',
    null: $ => 'null',
    undefined: $ => 'undefined',
    this: $ => 'this',
    super: $ => 'super',

    number: $ => token(choice(
      /0[xX][0-9a-fA-F](_?[0-9a-fA-F])*/,
      /0[bB][01](_?[01])*/,
      /0[oO][0-7](_?[0-7])*/,
      /[0-9](_?[0-9])*(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9](_?[0-9])*)?/,
    )),

    bigint: $ => token(choice(
      /0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n/,
      /0[bB][01](_?[01])*n/,
      /0[oO][0-7](_?[0-7])*n/,
      /[0-9](_?[0-9])*n/,
    )),

    string: $ => choice(
      seq("'", optional($.string_content_single), "'"),
      seq('"', optional($.string_content_double), '"'),
    ),

    string_content_single: $ => repeat1(choice(
      token.immediate(prec(1, /[^'\\]+/)),
      $.escape_sequence,
    )),

    string_content_double: $ => repeat1(choice(
      token.immediate(prec(1, /[^"\\]+/)),
      $.escape_sequence,
    )),

    escape_sequence: $ => token.immediate(seq(
      '\\',
      choice(
        /['"\\bfnrtv0]/,
        /x[0-9a-fA-F]{2}/,
        /u[0-9a-fA-F]{4}/,
        /u\{[0-9a-fA-F]+\}/,
        /\n/,
      ),
    )),

    template_string: $ => seq(
      '`',
      repeat(choice(
        $.template_content,
        $.template_substitution,
        $.escape_sequence,
      )),
      '`',
    ),

    template_content: $ => token.immediate(prec(1, /[^`\\$]+|(\$[^{])/)),

    template_substitution: $ => seq(
      token.immediate('${'),
      $._expression,
      '}',
    ),

    // --- Compound literals ---

    array: $ => seq(
      '[',
      optional(commaSep1($._expression)),
      ']',
    ),

    object: $ => prec.dynamic(-1, prec('object', seq(
      '{',
      optional(commaSep1($._object_property)),
      '}',
    ))),

    _object_property: $ => choice(
      $.pair,
      alias($.identifier, $.shorthand_property_identifier),
      $.method_definition,
      $.spread_expression,
    ),

    pair: $ => seq(
      field('key', $._property_name),
      ':',
      field('value', $._expression),
    ),

    computed_property_name: $ => seq('[', $._expression, ']'),

    _property_name: $ => choice(
      $.identifier,
      $.private_name,
      $.string,
      $.number,
      $.computed_property_name,
    ),

    private_name: $ => /#[a-zA-Z_$][a-zA-Z0-9_$]*/,

    method_definition: $ => seq(
      optional('async'),
      field('name', $._property_name),
      $.formal_parameters,
      field('body', $.block),
    ),

    // --- Functions ---

    function_expression: $ => prec('literal', seq(
      'function',
      optional(field('name', $.identifier)),
      $.formal_parameters,
      field('body', $.block),
    )),

    async_function_expression: $ => prec('literal', seq(
      'async',
      'function',
      optional(field('name', $.identifier)),
      $.formal_parameters,
      field('body', $.block),
    )),

    class_expression: $ => prec('literal', seq(
      'class',
      optional(field('name', $.identifier)),
      optional($.class_heritage),
      field('body', $.class_body),
    )),

    arrow_function: $ => prec.right('assignment', seq(
      field('parameters', choice(
        $.identifier,
        $.formal_parameters,
      )),
      '=>',
      field('body', choice($.block, $._expression)),
    )),

    async_arrow_function: $ => prec.right('assignment', seq(
      'async',
      field('parameters', choice(
        $.identifier,
        $.formal_parameters,
      )),
      '=>',
      field('body', choice($.block, $._expression)),
    )),

    // --- Invalid (highlighted as errors) ---

    invalid_loose_equality: $ => prec.left('equality', seq(
      field('left', $._expression),
      field('operator', choice('==', '!=')),
      field('right', $._expression),
    )),

    invalid_keyword: $ => choice(
      'class', 'switch', 'case', 'default',
      'void', 'delete', 'with', 'debugger',
      'yield', 'super', 'static', 'extends',
      'enum', 'import',
    ),

    // --- Tokens ---

    identifier: $ => /[a-zA-Z_$][a-zA-Z0-9_$]*/,

    comment: $ => token(choice(
      seq('//', /[^\n]*/),
      seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/'),
    )),
  },
});

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)), optional(','));
}
