// utils/calculateRisk.js
function calculateRiskScore(customer) {
  let score = 0;
  let ageFactor = 0, incomeFactor = 0, employmentFactor = 0, accountTypeFactor = 0, depositFactor = 0;

  // Age
  const birthDate = new Date(customer.date_of_birth);
  const age = Math.floor((Date.now() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  if (age >= 18 && age <= 25) ageFactor = 10;
  else if (age >= 26 && age <= 40) ageFactor = 5;
  else if (age >= 41 && age <= 60) ageFactor = 3;
  else if (age > 60) ageFactor = 8;
  score += ageFactor;

  // Income
  const income = parseFloat(customer.annual_income || 0);
  if (income < 30000) incomeFactor = 10;
  else if (income < 60000) incomeFactor = 5;
  else if (income < 100000) incomeFactor = 3;
  else incomeFactor = 1;
  score += incomeFactor;

  // Employment
  switch (customer.employment_status) {
    case 'UNEMPLOYED': employmentFactor = 10; break;
    case 'PART_TIME': employmentFactor = 7; break;
    case 'SELF_EMPLOYED': employmentFactor = 5; break;
    case 'FULL_TIME': employmentFactor = 2; break;
    default: employmentFactor = 5;
  }
  score += employmentFactor;

  // Account type
  switch (customer.account_type) {
    case 'INVESTMENT': accountTypeFactor = 1; break;
    case 'BUSINESS': accountTypeFactor = 3; break;
    case 'SAVINGS': accountTypeFactor = 5; break;
    case 'CHECKING': accountTypeFactor = 7; break;
    default: accountTypeFactor = 5;
  }
  score += accountTypeFactor;

  // Deposit
  const deposit = parseFloat(customer.initial_deposit || 0);
  if (deposit < 1000) depositFactor = 5;
  else if (deposit < 10000) depositFactor = 2;
  else if (deposit < 50000) depositFactor = 1;
  else depositFactor = 0;
  score += depositFactor;

  let riskLevel = 'LOW';
  if (score >= 41) riskLevel = 'HIGH';
  else if (score >= 21) riskLevel = 'MEDIUM';

  return {
    score, risk_level: riskLevel,
    age_factor: ageFactor, income_factor: incomeFactor,
    employment_factor: employmentFactor, account_type_factor: accountTypeFactor,
    deposit_factor: depositFactor
  };
}

module.exports = { calculateRiskScore };
